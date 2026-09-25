import { config } from '../config.ts';

/**
 * The agent SDK reports a cap two different ways, and both must land in the
 * same place.
 *
 * `runAgent` handled the result-message form. On 2026-09-25 the SDK instead
 * threw `Claude Code returned an error result: Reached maximum budget ($1.5)`,
 * the exception escaped the message loop, and every line after the loop was
 * skipped: the cost was not recorded, `model_usage` was not written, and a run
 * holding 8 qualified leads and 16 drafts was marked `failed` with no
 * shortfall reason rather than `partial`.
 *
 * Matching on message text is not something to enjoy, but the alternative is
 * treating a cap as a crash, and a crash is exactly what the status then says
 * to the person reading it.
 */
export type CapReached = 'error_max_budget_usd' | 'error_max_turns';

const BUDGET_TEXT = /maximum budget|max_budget|budget exceeded/i;
const TURNS_TEXT = /maximum (number of )?turns|max_turns/i;

export function capReached(
  subtype: string | undefined, errorMessage: string | undefined,
): CapReached | null {
  if (subtype === 'error_max_budget_usd' || subtype === 'error_max_turns') return subtype;
  if (!errorMessage) return null;
  if (BUDGET_TEXT.test(errorMessage)) return 'error_max_budget_usd';
  if (TURNS_TEXT.test(errorMessage)) return 'error_max_turns';
  return null;
}

/**
 * What the agent loop is known to have cost, at minimum.
 *
 * On the thrown path no result message arrives, so the SDK's own figure is
 * never read and the cost reads 0. Recording that is how a run that spent
 * $1.50 was booked at $0.073.
 *
 * A run stopped BY the spend cap spent at least the cap, so that is the floor.
 * A turn cap implies nothing about spend, because sixty cheap turns are
 * possible, so nothing is invented there.
 */
export function agentCostFloorUsd(reportedUsd: number, cap: CapReached | null): number {
  const reported = Number.isFinite(reportedUsd) && reportedUsd > 0 ? reportedUsd : 0;
  if (cap === 'error_max_budget_usd') return Math.max(reported, config.limits.maxBudgetUsd);
  return reported;
}

/**
 * Below this there is no point invoking the agent at all: it buys a turn of
 * thinking, no tool calls, and a cap message that reads in the record exactly
 * like a genuine short run.
 */
export const MIN_AGENT_BUDGET_USD = 0.10;

/**
 * WHAT THIS INVOCATION MAY SPEND, which is not what the RUN may spend.
 *
 * `AGENT_MAX_BUDGET_USD` was passed to the SDK as a flat number every time the
 * agent started. That is correct exactly once. A run whose worker dies is left
 * non-terminal with a stale lease, reclaimed fifteen minutes later and invoked
 * AGAIN, and the second invocation got a whole fresh cap. Three reclaims meant
 * three times the per-run ceiling, with nothing but the daily cap behind it.
 *
 * The ledger already knows what the run has spent, because `recordSpend`
 * refreshes `runs.claude_cost_usd` from it. Subtracting makes the cap mean per
 * RUN, which is what its name has always claimed.
 */
export function remainingRunBudgetUsd(alreadySpentUsd: string | number): number {
  // pg returns numeric columns as strings, and an unparseable one must read as
  // nothing spent: refusing a run because its own accounting is unreadable is
  // worse than letting it have the full cap.
  const spent = Number(alreadySpentUsd);
  const safe = Number.isFinite(spent) && spent > 0 ? spent : 0;
  return Math.max(0, config.limits.maxBudgetUsd - safe);
}

export function tooLittleLeftToStart(remainingUsd: number): boolean {
  return remainingUsd < MIN_AGENT_BUDGET_USD;
}
