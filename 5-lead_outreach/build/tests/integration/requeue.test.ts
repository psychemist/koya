import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requeueIfNothingProduced } from '../../lib/runs.ts';
import { query, one } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * A run refused before it started should not lock out its own objective.
 *
 * Idempotency is keyed on (objective, operator, day), which is right: an
 * impatient double submit must not queue two paid runs. But a run that failed
 * on a budget refusal produced nothing, and under that key the operator could
 * not retry the same objective for the rest of the day. On 2026-09-25 a run
 * was refused by a stale daily cap and the objective became unusable until
 * midnight.
 */
test('a run that failed having produced nothing can be queued again',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'failed', error_message: 'daily cap' } as any);

    assert.equal(await requeueIfNothingProduced(run.id), true);

    const [after] = await query<{ status: string; error_message: string | null }>(
      'select status, error_message from public.runs where id = $1', [run.id]);
    assert.equal(after.status, 'queued');
    assert.equal(after.error_message, null, 'the old failure was left on a fresh run');

    await dropRun(run.id);
  });

test('a run that produced leads is never silently restarted',
  { skip: skipWithoutDatabase }, async () => {
    // Requeueing this would re-run an agent over work already delivered and
    // double its spend, and the leads are the thing the operator came for.
    const run = await seedRun({ status: 'failed' });
    await one(
      `insert into public.leads (run_id, company_name, company_domain,
        qualification_status, confidence) values ($1,'A','a-requeue.com','qualified',0.8)
       returning id`, [run.id]);

    assert.equal(await requeueIfNothingProduced(run.id), false);
    const [after] = await query<{ status: string }>(
      'select status from public.runs where id = $1', [run.id]);
    assert.equal(after.status, 'failed');

    await dropRun(run.id);
  });

test('a finished run is not restarted, whatever it produced', { skip: skipWithoutDatabase },
  async () => {
    for (const status of ['complete', 'partial', 'discovering'] as const) {
      const run = await seedRun({ status } as any);
      assert.equal(await requeueIfNothingProduced(run.id), false, `${status} was restarted`);
      await dropRun(run.id);
    }
  });

test("the refused attempt's notifications do not follow it into the retry",
  { skip: skipWithoutDatabase }, async () => {
    /**
     * A run refused on a budget emits budget_exhausted_daily. Leaving that row
     * attached showed a budget alert against an attempt that then succeeded,
     * and the unique key (run_id, kind, scope) would stop the new attempt
     * emitting the same kinds at all.
     */
    const run = await seedRun({ status: 'failed' });
    await query(
      `insert into public.notifications (run_id, kind, scope, state)
       values ($1,'budget_exhausted_daily','2026-09-25','sent')`, [run.id]);

    assert.equal(await requeueIfNothingProduced(run.id), true);

    const [{ n }] = await query<{ n: string }>(
      'select count(*)::text n from public.notifications where run_id = $1', [run.id]);
    assert.equal(n, '0', 'the refused attempt left its alert on the retry');

    await dropRun(run.id);
  });
