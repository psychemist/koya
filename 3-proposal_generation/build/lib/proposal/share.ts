import { query, queryOne } from "../db";
import { generateToken, hashToken } from "../crypto";
import { AppError, ErrorCode } from "../errors";
import type { Status } from "./state";

/**
 * Client-facing proposal links.
 *
 * The token in the URL is 32 bytes of CSPRNG output; the database stores only
 * its SHA-256. So the link works, and a database dump does not hand anybody a
 * set of live client proposals.
 *
 * Deliberately plain SHA-256 rather than the HMAC used for sessions. Session
 * keys are HMAC'd with APP_SESSION_SECRET so that rotating the secret ends
 * every session at once — desirable for sessions, actively wrong here: these
 * links have been emailed to clients, and rotating an internal secret must not
 * silently break a URL a client is about to click.
 */

export type ShareLinkRow = {
  id: string;
  proposal_id: string;
  token_hash: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  view_count: number;
  last_viewed_at: Date | null;
  created_at: Date;
};

/**
 * The only statuses whose content a client may see.
 *
 * `approved` is included as well as `sent` because the send path issues the
 * link, dispatches, and only then transitions to `sent` — gating on `sent`
 * alone would 404 the client for the width of that window, and would break the
 * retry of a delivery that failed after the mail went out.
 */
const CLIENT_VISIBLE_STATUSES = new Set<Status>(["approved", "sent", "delivery_failed"]);

/** 60 days. Long enough for a client's procurement cycle, not indefinite. */
const DEFAULT_TTL_DAYS = 60;

/**
 * Issues a link, reusing the live one if there is one.
 *
 * Reuse matters for idempotency: re-sending a proposal, or retrying a failed
 * delivery, must not produce a second URL. The client may already have the
 * first one, and two live links to the same document is one more thing to
 * revoke and one more way to get it wrong.
 */
export async function ensureShareLink(
  proposalId: string,
  opts: { ttlDays?: number } = {},
): Promise<{ token: string | null; row: ShareLinkRow; created: boolean }> {
  const existing = await queryOne<ShareLinkRow>(
    `SELECT * FROM share_links
      WHERE proposal_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1`,
    [proposalId],
  );

  // The raw token is unrecoverable by design, so an existing link cannot have
  // its URL reconstructed. Callers that need a URL to send handle `null` by
  // rotating — see rotateShareLink.
  if (existing) return { token: null, row: existing, created: false };

  const token = generateToken();
  const expiresAt = new Date(Date.now() + (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000);

  const row = await queryOne<ShareLinkRow>(
    `INSERT INTO share_links (proposal_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [proposalId, hashToken(token), expiresAt],
  );
  if (!row) {
    throw new AppError({
      code: ErrorCode.INTERNAL,
      userMessage: "The share link could not be created.",
      message: "share_links insert returned no row",
    });
  }

  return { token, row, created: true };
}

/**
 * Revokes every live link and issues a fresh one. Used when a URL is needed
 * and the previous token is unrecoverable, and by the explicit "revoke link"
 * action.
 */
export async function rotateShareLink(
  proposalId: string,
  opts: { ttlDays?: number } = {},
): Promise<{ token: string; row: ShareLinkRow }> {
  await query(
    "UPDATE share_links SET revoked_at = now() WHERE proposal_id = $1 AND revoked_at IS NULL",
    [proposalId],
  );
  const created = await ensureShareLink(proposalId, opts);
  if (!created.token) {
    throw new AppError({
      code: ErrorCode.INTERNAL,
      userMessage: "The share link could not be rotated.",
      message: "rotate produced no token",
    });
  }
  return { token: created.token, row: created.row };
}

export async function revokeShareLinks(proposalId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    "UPDATE share_links SET revoked_at = now() WHERE proposal_id = $1 AND revoked_at IS NULL RETURNING id",
    [proposalId],
  );
  return rows.length;
}

export type ResolvedShare = {
  proposalId: string;
  ref: string;
  status: Status;
};

/**
 * Resolves a token from a client-facing URL.
 *
 * Returns null for every failure mode — unknown, revoked, expired — so the
 * public page cannot be used to distinguish "this link was cancelled" from
 * "this link never existed". A client who was sent a revoked link should ring
 * their contact, not read inferences off an error page.
 *
 * The view counter is incremented in the same statement that validates, so a
 * page load cannot be counted without the link having been valid.
 */
export async function resolveShareToken(token: string): Promise<ResolvedShare | null> {
  if (!token || token.length < 20 || token.length > 200) return null;

  const row = await queryOne<{ proposal_id: string; ref: string; status: Status }>(
    `UPDATE share_links s
        SET view_count = s.view_count + 1, last_viewed_at = now()
      FROM proposals p
     WHERE s.token_hash = $1
       AND s.proposal_id = p.id
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
     RETURNING s.proposal_id, p.ref, p.status`,
    [hashToken(token)],
  );

  if (!row) return null;

  /**
   * THE STATUS GATE.
   *
   * A valid token is not by itself permission to read the document. Whether
   * the proposal has cleared internal approval is a separate question, and
   * until this check existed nothing on the public path asked it — the page
   * and the PDF route both verified the token and the blocking-gap count, and
   * neither looked at `status`. Combined with the several places that minted a
   * token as a side effect of a read, that meant a pre-approval link was a
   * working link.
   *
   * Returning null rather than a distinct "not yet approved" keeps the public
   * surface uniform: unknown, revoked, expired and premature are one answer,
   * so no property of an internal workflow is readable from outside.
   */
  if (!CLIENT_VISIBLE_STATUSES.has(row.status)) return null;

  return { proposalId: row.proposal_id, ref: row.ref, status: row.status };
}

export async function getShareLinks(proposalId: string): Promise<ShareLinkRow[]> {
  return query<ShareLinkRow>(
    "SELECT * FROM share_links WHERE proposal_id = $1 ORDER BY created_at DESC",
    [proposalId],
  );
}

/**
 * Housekeeping: forget links that can no longer be used.
 *
 * Sessions and rate-limit buckets are already swept from the health endpoint;
 * share links were the third table that only ever grew. An expired or revoked
 * link is dead weight, and it is dead weight holding a hash tied to a client's
 * proposal — so removing it is a retention obligation, not just tidiness.
 *
 * Revoked rows are kept for 30 days first. A revocation is sometimes the
 * answer to "why can the client no longer open this?", and that question gets
 * asked in the days afterwards, not the months.
 */
export async function pruneDeadShareLinks(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM share_links
      WHERE (expires_at IS NOT NULL AND expires_at < now())
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
      RETURNING id`,
  );
  return rows.length;
}
