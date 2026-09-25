import { randomUUID } from 'node:crypto';
import { query, one } from '../lib/db.ts';
import type { RunRow } from '../lib/runs.ts';

/**
 * Integration tests run against the real database, because the constraints
 * are the thing under test. A mocked `save_lead` would happily accept a
 * qualified lead with no evidence, which is exactly the bug the CHECK exists
 * to make impossible.
 */
export async function seedRun(patch: Partial<RunRow> = {}): Promise<RunRow> {
  // Defaults first, then the patch overrides them. Spreading the patch keys
  // alongside fixed columns emitted `objective` twice whenever a test set it,
  // which Postgres rejects outright: the test never ran at all.
  const columns: Record<string, unknown> = {
    idempotency_key: randomUUID(),
    objective: 'test objective',
    ...patch,
  };
  const keys = Object.keys(columns);
  const vals = keys.map((k) => columns[k]);
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  const row = await one<RunRow>(
    `insert into public.runs (${keys.join(',')}) values (${placeholders}) returning *`,
    vals,
  );
  if (!row) throw new Error('seedRun inserted nothing');
  return row;
}

/**
 * Deletes the run and, by cascade, everything attached to it.
 *
 * The ledger is deleted explicitly because `spend_ledger.run_id` is ON DELETE
 * SET NULL, which is right in production (money spent is money spent, even if
 * the run is later deleted) and wrong in a test suite: synthetic spend
 * survives every run, accumulates against the real shared daily cap, and
 * eventually makes every reservation in the suite fail.
 */
export async function dropRun(runId: string): Promise<void> {
  await query('delete from public.spend_ledger where run_id = $1', [runId]);
  /**
   * Both of these outlive the cascade, and both are GLOBAL.
   *
   * `delivered_domains.first_run_id` is ON DELETE SET NULL, so a promotion made
   * during a test left a row behind that suppressed a domain for every future
   * run. Thirty-three of them had accumulated by 2026-09-25, all synthetic.
   * `judged_companies.run_id` is the same shape and feeds the overlap
   * measurement, where leftovers read as repeats that never happened.
   *
   * Deleted BEFORE the run, while first_run_id still points at it.
   */
  await query('delete from public.delivered_domains where first_run_id = $1', [runId]);
  await query('delete from public.judged_companies where run_id = $1', [runId]);
  await query('delete from public.runs where id = $1', [runId]);
}

export const skipWithoutDatabase = !process.env.DATABASE_URL;
