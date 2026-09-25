import { query, one } from './db.ts';

export type RunStatus =
  | 'queued' | 'refining_icp' | 'discovering' | 'researching' | 'drafting'
  | 'complete' | 'partial' | 'failed';

export const TERMINAL_STATUSES: RunStatus[] = ['complete', 'partial', 'failed'];

export type RunRow = {
  id: string;
  idempotency_key: string;
  objective: string;
  icp: Record<string, unknown> | null;
  status: RunStatus;
  version: number;
  needs_clarification: string | null;
  candidate_budget: number;
  candidates_used: number;
  scrape_budget: number;
  scrapes_used: number;
  target_leads: number;
  parent_run_id: string | null;
  apify_cap_usd: string | number;
  apify_spend_usd: string | number;
  claude_cost_usd: string | number;
  agent_turns: number;
  shortfall_reason: string | null;
  error_message: string | null;
  /** The person who started it. Null for runs created before accounts existed. */
  created_by: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
};

export type RunStats = {
  assessed: number;
  qualified: number;
  needsReview: number;
  notQualified: number;
  flaggedPages: number;
  blockedDrafts: number;
};

export async function loadRun(runId: string): Promise<RunRow> {
  const row = await one<RunRow>('select * from public.runs where id = $1', [runId]);
  if (!row) throw new Error(`Unknown run: ${runId}`);
  return row;
}

export const isTerminal = (status: string): boolean =>
  TERMINAL_STATUSES.includes(status as RunStatus);

/**
 * Version-checked transition. Every state change goes through here.
 *
 * Returns null when the row moved under us. A worker that resumes after a
 * crash must not advance a run another worker already advanced, and the honest
 * answer to that is "nothing happened", not a silent overwrite.
 */
export async function transition(
  runId: string,
  from: RunStatus | RunStatus[],
  to: RunStatus,
  version?: number,
  patch: Record<string, unknown> = {},
): Promise<RunRow | null> {
  const froms = Array.isArray(from) ? from : [from];
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 5}`);
  const sql = `
    update public.runs
       set status = $2, version = version + 1
           ${sets.length ? ', ' + sets.join(', ') : ''}
     where id = $1
       and status = any($3)
       and ($4::int is null or version = $4)
    returning *`;
  return one<RunRow>(sql, [runId, to, froms, version ?? null, ...keys.map((k) => patch[k])]);
}

/** The working states, in the order a run passes through them. */
export const WORKING_ORDER: RunStatus[] =
  ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'];

/**
 * Move a run forward to `to`, and only forward.
 *
 * The `from` list is every state earlier in the sequence, so this is
 * idempotent (a run already drafting stays drafting), monotonic (research
 * following a late second search does not drag the run backwards) and safe on
 * a finished run (a terminal status is in no `from` list, so the update
 * matches nothing).
 *
 * Without this the run sat in `discovering` from the first search to the last
 * draft, and the progress strip said so.
 */
export async function advanceTo(runId: string, to: RunStatus): Promise<RunRow | null> {
  const index = WORKING_ORDER.indexOf(to);
  if (index <= 0) return null;
  return transition(runId, WORKING_ORDER.slice(0, index), to);
}

/**
 * The scorecard, recomputed in code. `finish_run` compares this with what the
 * agent claims, and refuses to mark a run complete when the two disagree.
 */
export async function runStats(runId: string): Promise<RunStats> {
  const [leads] = await query<{
    assessed: string; qualified: string; needs_review: string;
    not_qualified: string; blocked: string;
  }>(
    `select count(*)::text                                                as assessed,
            count(*) filter (where qualification_status = 'qualified')::text     as qualified,
            count(*) filter (where qualification_status = 'needs_review')::text  as needs_review,
            count(*) filter (where qualification_status = 'not_qualified')::text as not_qualified,
            count(*) filter (where drafts_blocked is not null)::text             as blocked
       from public.leads where run_id = $1`,
    [runId],
  );
  const [pages] = await query<{ flagged: string }>(
    `select count(*) filter (where injection_flagged)::text as flagged
       from public.scraped_pages where run_id = $1`,
    [runId],
  );
  return {
    assessed: Number(leads?.assessed ?? 0),
    qualified: Number(leads?.qualified ?? 0),
    needsReview: Number(leads?.needs_review ?? 0),
    notQualified: Number(leads?.not_qualified ?? 0),
    blockedDrafts: Number(leads?.blocked ?? 0),
    flaggedPages: Number(pages?.flagged ?? 0),
  };
}
