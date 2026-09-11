import { query } from "./db";
import type { Role, User } from "./auth";

/**
 * Reading the audit trail back.
 *
 * `lib/audit.ts` is the write side: every action in the application goes
 * through `withAudit` and lands as a row in `events`. Until now the only way
 * to read those rows in the product was the System page, which shows the ones
 * that FAILED. That answers "what is broken" and not "who did what", and the
 * second question is the one a firm whose central control is an approval step
 * actually has to be able to answer: who drafted this, who sent it back, who
 * approved it, and when.
 *
 * So this module reads the same table from the other end — by person, in
 * order, whatever the outcome.
 *
 * WHAT EACH READER MAY SEE. The scope below mirrors `canAccess(…, "view")` in
 * lib/proposal/access.ts exactly, and it has to: a page that let a salesperson
 * read the action log of a colleague's deal would hand them, one event at a
 * time, the client references that `assertAccess` refuses them in one request.
 *
 *   admin        every event
 *   approver     their own events, plus every event against a proposal —
 *                an approver may already view any proposal
 *   salesperson  their own events, plus events against proposals they authored
 *
 * The rule is expressed once, in `scopeClause`, rather than being re-derived
 * per query, because three subtly different WHERE clauses is how one of them
 * ends up missing a term.
 */

export type ActivityRow = {
  id: string;
  at: Date;
  correlation_id: string;
  action: string;
  outcome: "ok" | "error" | "denied" | "skipped";
  error_code: string | null;
  latency_ms: number | null;
  detail: Record<string, unknown>;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: Role | null;
  proposal_id: string | null;
  proposal_ref: string | null;
  proposal_company: string | null;
};

export type ActorSummary = {
  actor_id: string;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  events: number;
  drafted: number;
  approvals: number;
  sends: number;
  refused: number;
  failed: number;
  proposals: number;
  last_at: Date | null;
};

export type ActivityTotals = {
  events: number;
  today: number;
  approvals: number;
  sends: number;
  refused: number;
  people: number;
};

/**
 * The visibility predicate, as SQL plus its parameters.
 *
 * Returns the clause and the values to bind, so a caller composes rather than
 * interpolates. Nothing user-supplied is ever concatenated into a statement
 * anywhere in this module.
 */
function scopeClause(viewer: User, nextParam: number): { sql: string; params: unknown[] } {
  if (viewer.role === "admin") {
    return { sql: "TRUE", params: [] };
  }
  if (viewer.role === "approver") {
    return {
      sql: `(e.actor_id = $${nextParam} OR e.proposal_id IS NOT NULL)`,
      params: [viewer.id],
    };
  }
  return {
    sql: `(e.actor_id = $${nextParam} OR p.author_id = $${nextParam})`,
    params: [viewer.id],
  };
}

/**
 * The actions worth naming in the interface.
 *
 * `events.action` is a free-text string written at each call site, which is
 * right for the log and wrong for a filter: a filter built from whatever
 * happens to be in the table grows a new chip every time someone adds a route.
 * These are the groups a person reasons in — the steps of the pipeline — and
 * each is matched by prefix so a new `proposal.approve.something` lands in the
 * right one without being added here.
 */
export const ACTION_GROUPS = [
  { key: "all", label: "Everything", prefixes: [] as string[] },
  {
    key: "draft",
    label: "Drafting",
    prefixes: ["proposal.create", "proposal.generate", "proposal.intake_edit", "proposal.source", "section."],
  },
  { key: "review", label: "Review", prefixes: ["proposal.submit", "comment.", "gap."] },
  { key: "approval", label: "Approval", prefixes: ["proposal.approve", "proposal.withdraw"] },
  {
    key: "delivery",
    label: "Delivery",
    prefixes: ["proposal.send", "proposal.document", "proposal.eml", "delivery.", "public."],
  },
  { key: "account", label: "Accounts", prefixes: ["auth.", "team."] },
] as const;

export type ActionGroupKey = (typeof ACTION_GROUPS)[number]["key"];

/** How many events one page of the trail shows. */
export const DEFAULT_PAGE_SIZE = 50;

/** The ceiling a caller cannot argue past. */
export const MAX_PAGE_SIZE = 200;

export type ActivityFilter = {
  actorId?: string | null;
  group?: ActionGroupKey;
  outcome?: "ok" | "error" | "denied" | "skipped" | null;
  limit?: number;
  offset?: number;
};

function groupPrefixes(key: ActionGroupKey | undefined): readonly string[] {
  return ACTION_GROUPS.find((g) => g.key === key)?.prefixes ?? [];
}

/**
 * One page of the trail, newest first.
 *
 * Offset paging rather than a keyset cursor. The ordering key is `at`, which
 * is not unique — two events written in the same millisecond would make a
 * cursor skip one or repeat one — and this table is read by a person clicking
 * through a few pages, not by a job walking a million rows. Offset is the
 * right trade at this size, and it keeps every filter expressible in the
 * query string, which is what makes a filtered view pasteable.
 *
 * The cap is still hard. A caller asking for more than `MAX_PAGE_SIZE` gets
 * `MAX_PAGE_SIZE`, because an unbounded query against a table that only grows
 * is fine for a month and then is not.
 */
export async function listActivity(viewer: User, filter: ActivityFilter = {}): Promise<ActivityRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const scope = scopeClause(viewer, params.length + 1);
  where.push(scope.sql);
  params.push(...scope.params);

  /**
   * A non-admin may narrow to one person, but only to a person they can
   * already see. Rather than validating the id against a list, the actor
   * filter is ANDed with the scope above, so an id the viewer is not entitled
   * to simply returns nothing — no membership oracle, no separate check to
   * forget.
   */
  if (filter.actorId) {
    params.push(filter.actorId);
    where.push(`e.actor_id = $${params.length}`);
  }

  if (filter.outcome) {
    params.push(filter.outcome);
    where.push(`e.outcome = $${params.length}`);
  }

  const prefixes = groupPrefixes(filter.group);
  if (prefixes.length > 0) {
    params.push(prefixes);
    // `LIKE ANY` over a bound array: the prefixes are constants from the table
    // above, and binding them keeps the statement shape identical either way.
    where.push(`e.action LIKE ANY (SELECT p || '%' FROM unnest($${params.length}::text[]) AS p)`);
  }

  params.push(Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE));
  const limitParam = params.length;

  params.push(Math.max(filter.offset ?? 0, 0));
  const offsetParam = params.length;

  return query<ActivityRow>(
    `SELECT e.id::text, e.at, e.correlation_id, e.action, e.outcome, e.error_code,
            e.latency_ms, e.detail,
            e.actor_id::text  AS actor_id,
            u.name            AS actor_name,
            u.email           AS actor_email,
            u.role            AS actor_role,
            e.proposal_id::text AS proposal_id,
            p.ref             AS proposal_ref,
            coalesce(p.intake->>'company_name', p.title) AS proposal_company
       FROM events e
       LEFT JOIN users u     ON u.id = e.actor_id
       LEFT JOIN proposals p ON p.id = e.proposal_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.at DESC, e.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
}

/**
 * The per-person roll-up: the table this page exists for.
 *
 * Counted from `events` rather than from the proposals table, because the
 * question is what somebody DID, and a proposal that was approved and then
 * withdrawn has to show both. Only rows with an actor are counted — a
 * scrubbed event from an erased proposal keeps its place in the trail but no
 * longer belongs to anyone.
 */
export async function listActors(viewer: User): Promise<ActorSummary[]> {
  const params: unknown[] = [];
  const scope = scopeClause(viewer, params.length + 1);
  params.push(...scope.params);

  return query<ActorSummary>(
    `SELECT u.id::text AS actor_id, u.name, u.email, u.role, u.is_active,
            count(e.id)::int                                                    AS events,
            count(*) FILTER (WHERE e.action LIKE 'proposal.generate%'
                                OR e.action LIKE 'proposal.section%')::int      AS drafted,
            count(*) FILTER (WHERE e.action LIKE 'proposal.approve%')::int      AS approvals,
            count(*) FILTER (WHERE e.action LIKE 'proposal.send%')::int         AS sends,
            count(*) FILTER (WHERE e.outcome = 'denied')::int                   AS refused,
            count(*) FILTER (WHERE e.outcome = 'error')::int                    AS failed,
            count(DISTINCT e.proposal_id)::int                                  AS proposals,
            max(e.at)                                                           AS last_at
       FROM users u
       JOIN events e         ON e.actor_id = u.id
       LEFT JOIN proposals p ON p.id = e.proposal_id
      WHERE ${scope.sql}
      GROUP BY u.id, u.name, u.email, u.role, u.is_active
      ORDER BY max(e.at) DESC`,
    params,
  );
}

export async function activityTotals(viewer: User): Promise<ActivityTotals> {
  const params: unknown[] = [];
  const scope = scopeClause(viewer, params.length + 1);
  params.push(...scope.params);

  const rows = await query<ActivityTotals>(
    `SELECT count(*)::int                                                     AS events,
            count(*) FILTER (WHERE e.at > now() - interval '24 hours')::int   AS today,
            count(*) FILTER (WHERE e.action LIKE 'proposal.approve%'
                               AND e.outcome = 'ok')::int                     AS approvals,
            count(*) FILTER (WHERE e.action LIKE 'proposal.send%'
                               AND e.outcome = 'ok')::int                     AS sends,
            count(*) FILTER (WHERE e.outcome = 'denied')::int                 AS refused,
            count(DISTINCT e.actor_id)::int                                   AS people
       FROM events e
       LEFT JOIN proposals p ON p.id = e.proposal_id
      WHERE ${scope.sql}`,
    params,
  );

  return (
    rows[0] ?? { events: 0, today: 0, approvals: 0, sends: 0, refused: 0, people: 0 }
  );
}

/**
 * A readable sentence for one event.
 *
 * `events.action` is a dotted machine string: correct in a log line, wrong as
 * the only thing a person is given. The map below covers what the pipeline
 * actually writes; anything unmapped degrades to the dotted string with its
 * separators turned into spaces, which is still readable and never blank.
 */
const ACTION_LABEL: Record<string, string> = {
  "proposal.create": "Created the proposal",
  "proposal.intake_edit": "Updated the intake",
  "proposal.generate": "Drafted the proposal with Claude",
  "proposal.source_upload": "Attached supporting material",
  "proposal.source_ocr": "Transcribed a scanned upload",
  "section.regenerate": "Regenerated a section",
  "section.edit": "Edited a section by hand",
  "section.revert": "Reverted a section",
  "section.history": "Read a section's history",
  "proposal.submit": "Sent the proposal for review",
  "comment.create": "Left a review comment",
  "comment.resolve": "Resolved a review comment",
  "comment.list": "Read the review comments",
  "gap.decide": "Decided on a gap",
  "gap.list": "Read the open gaps",
  "proposal.approve": "Approved the proposal",
  "proposal.withdraw": "Withdrew the proposal",
  "proposal.send": "Sent the proposal to the client",
  "proposal.send.preview": "Previewed the client email",
  "proposal.send.pdf_failed": "Send went out without its PDF",
  "proposal.send.origin_unresolved": "Send could not build a client link",
  "proposal.document": "Downloaded the document",
  "proposal.eml": "Downloaded the .eml",
  "delivery.duplicate_suppressed": "Duplicate send refused",
  "public.proposal_view": "The client opened the proposal",
  "public.proposal_pdf": "The client downloaded the PDF",
  "auth.sign_in": "Signed in",
  "auth.sign_out": "Signed out",
  "auth.register": "Created an account",
  "team.invite": "Authorised an address",
  "team.invite.revoke": "Withdrew an invitation",
  "team.invites.list": "Read the invitation list",
  "team.member.update": "Changed a colleague's role or status",
};

export function actionLabel(action: string): string {
  const exact = ACTION_LABEL[action];
  if (exact) return exact;
  const prefix = Object.keys(ACTION_LABEL).find((k) => action.startsWith(`${k}.`));
  if (prefix) return ACTION_LABEL[prefix]!;
  return action.replace(/[._]/g, " ");
}
