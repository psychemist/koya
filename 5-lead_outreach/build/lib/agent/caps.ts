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
