import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "../db";
import { AppError, ErrorCode, errors } from "../errors";
import { canonicalJson, sha256Hex } from "../crypto";
import { intakeSchema, type GapCandidate, type Intake } from "./intake";
import { PROMPT_INTAKE_FIELDS } from "../claude/prompts";
import { SECTIONS, type SectionKey } from "./sections";
import type { Status } from "./state";

/**
 * Stable hash of the intake, for change detection and the generation cache.
 *
 * Lives here rather than in intake.ts because it uses SHA-256, which is
 * server-only — and unlike a gap fingerprint this one IS a content hash where
 * a collision would serve the wrong cached draft, so the strong algorithm is
 * worth the constraint. See lib/hash.ts for the reasoning behind the split.
 */
export function intakeHash(intake: Intake): string {
  return sha256Hex(canonicalJson(intake));
}

/**
 * Data access for proposals.
 *
 * Every function that changes state does so through a guarded UPDATE or a
 * natural unique key, never through read-then-write in application code. That
 * is the difference between "we check before we act" — which two concurrent
 * requests both pass — and "the database refuses the second one".
 */

export type ProposalRow = {
  id: string;
  ref: string;
  status: Status;
  version: number;
  author_id: string;
  approver_id: string | null;
  title: string | null;
  intake: Intake;
  assigned_approver_id: string | null;
  intake_hash: string | null;
  content_hash: string | null;
  currency: string;
  cost_micro_usd: string; // bigint arrives as a string from pg
  idempotency_key: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type SectionRow = {
  id: string;
  proposal_id: string;
  key: SectionKey;
  heading: string;
  body_md: string;
  position: number;
  version: number;
  edited_by_human: boolean;
  generated_by_ai_call_id: string | null;
  updated_at: Date;
};

export type SourceRow = {
  id: string;
  proposal_id: string;
  filename: string;
  mime: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  extracted_text: string;
  extract_status: "pending" | "ok" | "empty" | "unsupported" | "failed";
  extract_error: string | null;
  created_at: Date;
};

export type GapRow = {
  id: string;
  proposal_id: string;
  section_key: SectionKey | null;
  field: string | null;
  severity: "blocking" | "advisory";
  message: string;
  detected_by: "validator" | "model" | "grounding" | "scanner" | "style";
  status: "open" | "resolved" | "waived";
  waiver_reason: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  fingerprint: string;
  created_at: Date;
};

// ---------------------------------------------------------------- proposals

/**
 * Creates a proposal, or returns the existing one for the same idempotency key.
 *
 * The double-submit this defends against is entirely ordinary: a slow network,
 * an impatient second click, a mobile browser replaying a request on wake. The
 * unique index does the work — we attempt the insert and treat a conflict as a
 * successful lookup, rather than checking first and racing.
 */
export async function createProposal(args: {
  authorId: string;
  intake: Intake;
  idempotencyKey: string;
}): Promise<{ proposal: ProposalRow; created: boolean }> {
  const parsed = intakeSchema.parse(args.intake);
  const hash = intakeHash(parsed);
  const title = `${parsed.company_name} · ${parsed.client_name}`;

  return transaction(async (client) => {
    const inserted = await client.query<ProposalRow>(
      `INSERT INTO proposals (ref, author_id, title, intake, intake_hash, idempotency_key)
       VALUES (
         'KOY-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('proposal_ref_seq')::text, 4, '0'),
         $1, $2, $3::jsonb, $4, $5
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [args.authorId, title, JSON.stringify(parsed), hash, args.idempotencyKey],
    );

    if (inserted.rows.length > 0) {
      const proposal = inserted.rows[0]!;
      await seedSections(client, proposal.id);
      return { proposal, created: true };
    }

    // Conflict: the key already exists, so return what the first request made.
    const existing = await client.query<ProposalRow>(
      "SELECT * FROM proposals WHERE idempotency_key = $1",
      [args.idempotencyKey],
    );
    const proposal = existing.rows[0];
    if (!proposal) throw errors.notFound("That proposal");
    return { proposal, created: false };
  });
}

/**
 * Creates the seven section rows up front, empty.
 *
 * Doing this at creation rather than at generation time means a section always
 * exists to be written into, so generation is a series of UPDATEs on known
 * rows. It also means the document outline renders immediately, before
 * anything has been written.
 */
async function seedSections(client: PoolClient, proposalId: string): Promise<void> {
  const values = SECTIONS.map(
    (_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`,
  ).join(", ");
  const params: unknown[] = [proposalId];
  for (const s of SECTIONS) params.push(s.key, s.heading, s.position);

  await client.query(
    `INSERT INTO proposal_sections (proposal_id, key, heading, position)
     VALUES ${values}
     ON CONFLICT (proposal_id, key) DO NOTHING`,
    params,
  );
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  return queryOne<ProposalRow>("SELECT * FROM proposals WHERE id = $1", [id]);
}

export async function getProposalOrThrow(id: string): Promise<ProposalRow> {
  const row = await getProposal(id);
  if (!row) throw errors.notFound("That proposal");
  return row;
}

export type ProposalListItem = ProposalRow & {
  author_name: string;
  approver_name: string | null;
  open_blocking_gaps: number;
  open_advisory_gaps: number;
  source_count: number;
  written_sections: number;
};

export async function listProposals(opts: {
  status?: Status | "all";
  authorId?: string;
  search?: string;
  limit?: number;
}): Promise<ProposalListItem[]> {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];

  if (opts.status && opts.status !== "all") {
    params.push(opts.status);
    clauses.push(`p.status = $${params.length}`);
  }
  if (opts.authorId) {
    params.push(opts.authorId);
    clauses.push(`p.author_id = $${params.length}`);
  }
  if (opts.search && opts.search.trim().length > 0) {
    params.push(`%${opts.search.trim()}%`);
    // ILIKE across the three things a person searches by. Not full-text: the
    // dataset is small and a GIN index here would be premature.
    clauses.push(
      `(p.ref ILIKE $${params.length} OR p.title ILIKE $${params.length} OR p.intake->>'company_name' ILIKE $${params.length})`,
    );
  }

  params.push(Math.min(opts.limit ?? 100, 200));

  return query<ProposalListItem>(
    `SELECT p.*,
            u.name AS author_name,
            a.name AS approver_name,
            count(DISTINCT g.id) FILTER (WHERE g.status = 'open' AND g.severity = 'blocking')::int AS open_blocking_gaps,
            count(DISTINCT g.id) FILTER (WHERE g.status = 'open' AND g.severity = 'advisory')::int AS open_advisory_gaps,
            count(DISTINCT s.id)::int AS source_count,
            count(DISTINCT ps.id) FILTER (WHERE length(btrim(ps.body_md)) > 0)::int AS written_sections
       FROM proposals p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN users a ON a.id = p.approver_id
       LEFT JOIN gaps g ON g.proposal_id = p.id
       LEFT JOIN sources s ON s.proposal_id = p.id
       LEFT JOIN proposal_sections ps ON ps.proposal_id = p.id
      WHERE ${clauses.join(" AND ")}
      GROUP BY p.id, u.name, a.name
      ORDER BY p.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * Updates the intake. Returns the new row, or throws on a version mismatch.
 *
 * The version guard is what makes two people editing the same proposal safe:
 * the second write fails loudly and the UI reloads, rather than silently
 * overwriting the first person's changes.
 */
export async function updateIntake(args: {
  proposalId: string;
  intake: Intake;
  expectedVersion: number;
}): Promise<ProposalRow> {
  const parsed = intakeSchema.parse(args.intake);
  const row = await queryOne<ProposalRow>(
    `UPDATE proposals
        SET intake = $2::jsonb,
            intake_hash = $3,
            title = $4,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND version = $5
      RETURNING *`,
    [
      args.proposalId,
      JSON.stringify(parsed),
      intakeHash(parsed),
      `${parsed.company_name} · ${parsed.client_name}`,
      args.expectedVersion,
    ],
  );
  if (!row) throw errors.concurrent();
  return row;
}

/**
 * Moves a proposal between states, atomically.
 *
 * `WHERE status = $2 AND version = $3` is the whole safety property: two
 * concurrent approvals both read `pending_approval`, both issue this UPDATE,
 * and exactly one matches. The loser gets a CONCURRENT_MODIFICATION error
 * telling it to reload.
 */
export async function transitionStatus(args: {
  proposalId: string;
  from: Status;
  to: Status;
  expectedVersion: number;
  approverId?: string | null;
  client?: PoolClient;
}): Promise<ProposalRow> {
  const sql = `UPDATE proposals
                  SET status = $3,
                      version = version + 1,
                      approver_id = COALESCE($5, approver_id),
                      submitted_at = CASE WHEN $3 = 'pending_approval' THEN now() ELSE submitted_at END,
                      approved_at  = CASE WHEN $3 = 'approved' THEN now() ELSE approved_at END,
                      sent_at      = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END,
                      updated_at = now()
                WHERE id = $1 AND status = $2 AND version = $4
                RETURNING *`;
  const params = [
    args.proposalId,
    args.from,
    args.to,
    args.expectedVersion,
    args.approverId ?? null,
  ];

  const rows = args.client
    ? (await args.client.query<ProposalRow>(sql, params)).rows
    : await query<ProposalRow>(sql, params);

  const row = rows[0];
  if (!row) throw errors.concurrent();
  return row;
}

export async function setContentHash(proposalId: string, hash: string): Promise<void> {
  await query("UPDATE proposals SET content_hash = $2, updated_at = now() WHERE id = $1", [
    proposalId,
    hash,
  ]);
}

// ----------------------------------------------------------------- sections

export async function getSections(proposalId: string): Promise<SectionRow[]> {
  return query<SectionRow>(
    "SELECT * FROM proposal_sections WHERE proposal_id = $1 ORDER BY position",
    [proposalId],
  );
}

/**
 * Writes one section and appends its previous state to the history.
 *
 * This is the operation behind "revise or regenerate one section without
 * losing the rest": it touches exactly one row in `proposal_sections`, and the
 * version it replaces is preserved in `section_versions` so it can be restored.
 * No other section is read, locked, or written.
 */
export async function writeSection(args: {
  proposalId: string;
  key: SectionKey;
  bodyMd: string;
  origin: "ai_draft" | "ai_regeneration" | "human_edit" | "revert";
  actorId?: string | null;
  instruction?: string | null;
  aiCallId?: string | null;
  /** Human edits set this; AI writes leave the existing flag alone. */
  markEditedByHuman?: boolean;
}): Promise<SectionRow> {
  return transaction(async (client) => {
    const current = await client.query<SectionRow>(
      "SELECT * FROM proposal_sections WHERE proposal_id = $1 AND key = $2 FOR UPDATE",
      [args.proposalId, args.key],
    );
    const existing = current.rows[0];
    if (!existing) throw errors.notFound(`Section "${args.key}"`);

    const nextVersion = existing.version + 1;

    const updated = await client.query<SectionRow>(
      `UPDATE proposal_sections
          SET body_md = $3,
              version = $4,
              edited_by_human = CASE WHEN $5 THEN true ELSE edited_by_human END,
              generated_by_ai_call_id = COALESCE($6, generated_by_ai_call_id),
              updated_at = now()
        WHERE proposal_id = $1 AND key = $2
        RETURNING *`,
      [
        args.proposalId,
        args.key,
        args.bodyMd,
        nextVersion,
        args.markEditedByHuman ?? false,
        args.aiCallId ?? null,
      ],
    );

    await client.query(
      `INSERT INTO section_versions
         (section_id, proposal_id, version, heading, body_md, origin, instruction, ai_call_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (section_id, version) DO NOTHING`,
      [
        existing.id,
        args.proposalId,
        nextVersion,
        existing.heading,
        args.bodyMd,
        args.origin,
        args.instruction ?? null,
        args.aiCallId ?? null,
        args.actorId ?? null,
      ],
    );

    await client.query("UPDATE proposals SET updated_at = now() WHERE id = $1", [args.proposalId]);

    return updated.rows[0]!;
  });
}

export type SectionVersionRow = {
  id: string;
  section_id: string;
  version: number;
  heading: string;
  body_md: string;
  origin: string;
  instruction: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: Date;
};

export async function getSectionHistory(
  proposalId: string,
  key: SectionKey,
): Promise<SectionVersionRow[]> {
  return query<SectionVersionRow>(
    `SELECT sv.*, u.name AS actor_name
       FROM section_versions sv
       JOIN proposal_sections ps ON ps.id = sv.section_id
       LEFT JOIN users u ON u.id = sv.actor_id
      WHERE sv.proposal_id = $1 AND ps.key = $2
      ORDER BY sv.version DESC
      LIMIT 50`,
    [proposalId, key],
  );
}

// ------------------------------------------------------------------ sources

export async function getSources(proposalId: string): Promise<SourceRow[]> {
  return query<SourceRow>(
    "SELECT * FROM sources WHERE proposal_id = $1 ORDER BY created_at",
    [proposalId],
  );
}

/**
 * Records an uploaded file. The same bytes uploaded twice produce one row —
 * content-addressed on sha256, so a renamed duplicate dedupes too.
 */
export async function addSource(args: {
  proposalId: string;
  filename: string;
  mime: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  extractedText: string;
  extractStatus: SourceRow["extract_status"];
  extractError: string | null;
}): Promise<{ source: SourceRow; created: boolean }> {
  const inserted = await query<SourceRow>(
    `INSERT INTO sources
       (proposal_id, filename, mime, byte_size, sha256, page_count,
        extracted_text, extract_status, extract_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (proposal_id, sha256) DO NOTHING
     RETURNING *`,
    [
      args.proposalId,
      args.filename,
      args.mime,
      args.byteSize,
      args.sha256,
      args.pageCount,
      args.extractedText,
      args.extractStatus,
      args.extractError,
    ],
  );

  if (inserted[0]) return { source: inserted[0], created: true };

  const existing = await queryOne<SourceRow>(
    "SELECT * FROM sources WHERE proposal_id = $1 AND sha256 = $2",
    [args.proposalId, args.sha256],
  );
  if (!existing) throw errors.notFound("That upload");
  return { source: existing, created: false };
}

export async function deleteSource(proposalId: string, sourceId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "DELETE FROM sources WHERE proposal_id = $1 AND id = $2 RETURNING id",
    [proposalId, sourceId],
  );
  return rows.length > 0;
}

// --------------------------------------------------------------------- gaps

export async function getGaps(proposalId: string): Promise<GapRow[]> {
  return query<GapRow>(
    `SELECT * FROM gaps WHERE proposal_id = $1
      ORDER BY (status = 'open') DESC,
               (severity = 'blocking') DESC,
               created_at`,
    [proposalId],
  );
}

/**
 * The open blocking gaps themselves, for a refusal that can name them.
 *
 * `countOpenBlockingGaps` answers "may this proceed", which is all a guard
 * needs. It is not enough for the person being refused: "a blocking gap was
 * reopened after approval" sent somebody to the deliver page, which does not
 * show the gap panel, with no way to find out which gap or what was missing.
 * A refusal that does not name the thing to fix is a dead end.
 */
export async function openBlockingGaps(
  proposalId: string,
): Promise<{ field: string | null; message: string }[]> {
  return query<{ field: string | null; message: string }>(
    `SELECT field, message FROM gaps
      WHERE proposal_id = $1 AND status = 'open' AND severity = 'blocking'
      ORDER BY field NULLS LAST`,
    [proposalId],
  );
}

export async function countOpenBlockingGaps(proposalId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM gaps
      WHERE proposal_id = $1 AND status = 'open' AND severity = 'blocking'`,
    [proposalId],
  );
  return row?.n ?? 0;
}

/**
 * Reconciles the gaps found by one detector with what is already stored.
 *
 * Re-running detection is the normal case — it happens on every save,
 * generation and regeneration — so this has to be idempotent in a way that
 * respects human decisions. Three rules:
 *
 *   - A gap detected again that was previously auto-resolved REOPENS. The
 *     condition is back, so the record should say so.
 *   - A gap detected again that a human WAIVED stays waived. The waiver is an
 *     explicit decision with a written reason attached; re-detecting the same
 *     condition is not new information and must not silently undo it.
 *   - A stored gap from this detector that is no longer detected is resolved
 *     automatically, unless it was waived. The condition is gone.
 *
 * Scoping by detector matters: a validator re-run must not close the gaps the
 * grounding gate found, because the validator knows nothing about them.
 */
export async function syncGaps(args: {
  proposalId: string;
  detectedBy: GapRow["detected_by"];
  candidates: readonly GapCandidate[];
}): Promise<{ opened: number; reopened: number; autoResolved: number }> {
  return transaction(async (client) => {
    const fingerprints = args.candidates.map((c) => c.fingerprint);

    // Read the current state first. The counts returned by this function are
    // reported to the user ("2 new gaps, 1 reopened"), so they have to be
    // derived from what was actually there before the write rather than
    // inferred from the upsert's own output.
    const before = await client.query<{ fingerprint: string; status: string }>(
      "SELECT fingerprint, status FROM gaps WHERE proposal_id = $1 AND detected_by = $2",
      [args.proposalId, args.detectedBy],
    );
    const priorStatus = new Map(before.rows.map((r) => [r.fingerprint, r.status]));

    let opened = 0;
    let reopened = 0;

    for (const c of args.candidates) {
      const prior = priorStatus.get(c.fingerprint);
      if (prior === undefined) opened += 1;
      else if (prior === "resolved") reopened += 1;
      // prior === 'open' is unchanged; prior === 'waived' stays waived.

      await client.query(
        `INSERT INTO gaps
           (proposal_id, section_key, field, severity, message, detected_by, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (proposal_id, fingerprint) DO UPDATE
           SET severity = EXCLUDED.severity,
               message  = EXCLUDED.message,
               section_key = EXCLUDED.section_key,
               field = EXCLUDED.field,
               -- A waiver survives re-detection; an auto-resolution does not.
               status = CASE WHEN gaps.status = 'waived' THEN 'waived' ELSE 'open' END,
               resolved_by = CASE WHEN gaps.status = 'waived' THEN gaps.resolved_by ELSE NULL END,
               resolved_at = CASE WHEN gaps.status = 'waived' THEN gaps.resolved_at ELSE NULL END`,
        [
          args.proposalId,
          c.sectionKey,
          c.field,
          c.severity,
          c.message,
          args.detectedBy,
          c.fingerprint,
        ],
      );
    }

    // Close what this detector no longer reports.
    const autoResolved = await client.query<{ id: string }>(
      `UPDATE gaps
          SET status = 'resolved', resolved_at = now()
        WHERE proposal_id = $1
          AND detected_by = $2
          AND status = 'open'
          AND NOT (fingerprint = ANY($3::text[]))
        RETURNING id`,
      [args.proposalId, args.detectedBy, fingerprints],
    );

    return { opened, reopened, autoResolved: autoResolved.rows.length };
  });
}

export async function resolveGap(args: {
  proposalId: string;
  gapId: string;
  actorId: string;
}): Promise<GapRow> {
  const row = await queryOne<GapRow>(
    `UPDATE gaps
        SET status = 'resolved', resolved_by = $3, resolved_at = now()
      WHERE proposal_id = $1 AND id = $2 AND status <> 'waived'
      RETURNING *`,
    [args.proposalId, args.gapId, args.actorId],
  );
  if (!row) throw errors.notFound("That gap");
  return row;
}

/**
 * Waives a gap. The reason is mandatory and length-checked in the database as
 * well as here — a waiver without a stated reason is indistinguishable from
 * clicking through a warning, which is what the gate exists to prevent.
 */
export async function waiveGap(args: {
  proposalId: string;
  gapId: string;
  actorId: string;
  reason: string;
}): Promise<GapRow> {
  const reason = args.reason.trim();
  if (reason.length < 10) {
    throw errors.validation(
      "A waiver needs a reason of at least ten characters. It goes in the audit trail, and 'ok' will not help whoever reads it next.",
    );
  }
  const row = await queryOne<GapRow>(
    `UPDATE gaps
        SET status = 'waived', waiver_reason = $4, resolved_by = $3, resolved_at = now()
      WHERE proposal_id = $1 AND id = $2
      RETURNING *`,
    [args.proposalId, args.gapId, args.actorId, reason],
  );
  if (!row) throw errors.notFound("That gap");
  return row;
}

export async function reopenGap(proposalId: string, gapId: string): Promise<GapRow> {
  const row = await queryOne<GapRow>(
    `UPDATE gaps
        SET status = 'open', waiver_reason = NULL, resolved_by = NULL, resolved_at = NULL
      WHERE proposal_id = $1 AND id = $2
      RETURNING *`,
    [proposalId, gapId],
  );
  if (!row) throw errors.notFound("That gap");
  return row;
}

// ---------------------------------------------------------------- approvals

export async function recordApproval(args: {
  proposalId: string;
  actorId: string;
  decision: "approved" | "changes_requested";
  note?: string | null;
  client?: PoolClient;
}): Promise<void> {
  const sql = `INSERT INTO approvals (proposal_id, actor_id, decision, note)
               VALUES ($1, $2, $3, $4)`;
  const params = [args.proposalId, args.actorId, args.decision, args.note ?? null];
  if (args.client) await args.client.query(sql, params);
  else await query(sql, params);
}

export type ApprovalRow = {
  id: string;
  decision: "approved" | "changes_requested";
  note: string | null;
  created_at: Date;
  actor_name: string;
  actor_email: string;
};

export async function getApprovals(proposalId: string): Promise<ApprovalRow[]> {
  return query<ApprovalRow>(
    `SELECT a.id, a.decision, a.note, a.created_at, u.name AS actor_name, u.email AS actor_email
       FROM approvals a JOIN users u ON u.id = a.actor_id
      WHERE a.proposal_id = $1
      ORDER BY a.created_at DESC`,
    [proposalId],
  );
}

// -------------------------------------------------------- generation caching

/**
 * The generation cache key.
 *
 * Covers everything that could change the output: the intake, the source
 * texts, the prompt version, and the model. A request whose key matches the
 * stored `content_hash` is served from the database for zero tokens.
 *
 * Source texts are sorted before hashing, so uploading two files in the other
 * order is still a cache hit — without that, the key would depend on upload
 * order and the cache would miss for no reason.
 */
export function generationHash(args: {
  intake: Intake;
  sourceTexts: readonly string[];
  promptVersion: string;
  model: string;
}): string {
  /**
   * Hashed over what the MODEL sees, not over the whole intake.
   *
   * `client_email` is not in the prompt - see PROMPT_INTAKE_FIELDS - so
   * hashing it would make correcting a typo in the client's address
   * invalidate the cache and buy a byte-identical draft a second time, at
   * full Opus price, for a field the model was never shown.
   *
   * It also makes `draftIsStale` truthful. That check asks whether the prose
   * was written from details that have since changed; an address the prose
   * cannot contain is not such a detail, and warning about it would be crying
   * wolf on the one screen where the warning needs to be believed.
   */
  const visible: Record<string, unknown> = {};
  for (const key of PROMPT_INTAKE_FIELDS) visible[key] = args.intake[key];

  return sha256Hex(
    canonicalJson({
      intake: visible,
      sources: [...args.sourceTexts].sort(),
      promptVersion: args.promptVersion,
      model: args.model,
    }),
  );
}

// ------------------------------------------------------------------ comments

export type CommentRow = {
  id: string;
  proposal_id: string;
  section_key: string | null;
  author_id: string;
  body: string;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
};

export type CommentView = CommentRow & {
  author_name: string;
  resolver_name: string | null;
};

/**
 * Review comments, newest last.
 *
 * Ordered ascending because a comment thread is read top to bottom like a
 * conversation, unlike the event log, which is read newest-first because you
 * are looking for what just broke.
 */
export async function getComments(proposalId: string): Promise<CommentView[]> {
  return query<CommentView>(
    `SELECT c.*, u.name AS author_name, r.name AS resolver_name
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN users r ON r.id = c.resolved_by
      WHERE c.proposal_id = $1
      ORDER BY c.created_at ASC`,
    [proposalId],
  );
}

export async function countOpenComments(proposalId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM comments WHERE proposal_id = $1 AND resolved_at IS NULL",
    [proposalId],
  );
  return row?.n ?? 0;
}

export async function addComment(args: {
  proposalId: string;
  sectionKey: string | null;
  authorId: string;
  body: string;
}): Promise<CommentRow> {
  const body = args.body.trim();
  if (body.length === 0) {
    throw errors.validation("A comment needs some text.");
  }
  if (body.length > 4000) {
    throw errors.validation("That comment is too long. Keep it under 4,000 characters.");
  }

  const row = await queryOne<CommentRow>(
    `INSERT INTO comments (proposal_id, section_key, author_id, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [args.proposalId, args.sectionKey, args.authorId, body],
  );
  if (!row) {
    throw new AppError({
      code: ErrorCode.INTERNAL,
      userMessage: "The comment could not be saved.",
      message: "comments insert returned no row",
    });
  }
  return row;
}

/**
 * Closes a comment, or reopens it.
 *
 * Idempotent in both directions: resolving a resolved comment is a no-op
 * rather than an error, because two people clicking the same button a moment
 * apart is a normal thing that happens and not a conflict worth surfacing.
 */
export async function setCommentResolved(args: {
  proposalId: string;
  commentId: string;
  actorId: string;
  resolved: boolean;
}): Promise<CommentRow> {
  const row = await queryOne<CommentRow>(
    `UPDATE comments
        SET resolved_at = CASE WHEN $4 THEN COALESCE(resolved_at, now()) ELSE NULL END,
            resolved_by = CASE WHEN $4 THEN COALESCE(resolved_by, $3) ELSE NULL END
      WHERE id = $2 AND proposal_id = $1
      RETURNING *`,
    [args.proposalId, args.commentId, args.actorId, args.resolved],
  );
  if (!row) throw errors.notFound("That comment");
  return row;
}

/**
 * The people a proposal can be assigned to for approval.
 *
 * Approvers and administrators, active only. A deactivated account cannot
 * sign anything off, and offering one in a picker produces a proposal that
 * sits waiting on somebody who has left.
 */
export async function listAssignableApprovers(): Promise<
  { id: string; name: string; email: string; role: string }[]
> {
  return query<{ id: string; name: string; email: string; role: string }>(
    `SELECT id::text, name, email, role
       FROM users
      WHERE is_active AND role IN ('approver', 'admin')
      ORDER BY role = 'approver' DESC, lower(name)`,
  );
}

/**
 * Assigns, or clears, the intended approver.
 *
 * Validated against the same list the picker is built from rather than
 * trusting the id: a salesperson who can post an arbitrary uuid could
 * otherwise assign a proposal to a deactivated account, or to a colleague
 * with no approval rights, and it would sit in a queue nobody can clear.
 *
 * The author cannot assign themselves even when they hold the approver role.
 * `assertCanApprove` would refuse it at the decision, so allowing it here
 * only builds a queue entry that can never be actioned.
 */
export async function setAssignedApprover(args: {
  proposalId: string;
  approverId: string | null;
  authorId: string;
}): Promise<void> {
  if (args.approverId === null) {
    await query(
      "UPDATE proposals SET assigned_approver_id = NULL, updated_at = now() WHERE id = $1",
      [args.proposalId],
    );
    return;
  }

  if (args.approverId === args.authorId) {
    throw errors.validation(
      "You cannot assign a proposal to yourself. Approval exists to get a second pair of eyes on it.",
    );
  }

  const allowed = await listAssignableApprovers();
  if (!allowed.some((a) => a.id === args.approverId)) {
    throw errors.validation(
      "That person cannot approve proposals. Pick somebody from the list.",
    );
  }

  await query(
    "UPDATE proposals SET assigned_approver_id = $2, updated_at = now() WHERE id = $1",
    [args.proposalId, args.approverId],
  );
}
