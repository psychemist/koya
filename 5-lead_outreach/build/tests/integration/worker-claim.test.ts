import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimOne } from '../../worker/index.ts';
import { query } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * These assert against a specific seeded run rather than against "the queue is
 * empty", because the integration files run concurrently against one database
 * and a global assertion is really an assertion about what other test files
 * happen to be doing at the time.
 */
async function isClaimable(runId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `select id from public.runs
      where id = $1
        and needs_clarification is null
        and paused_at is null
        and ((status = 'queued' and claimed_at is null)
             or (status not in ('complete','partial','failed')
                 and claimed_at < now() - interval '15 minutes'))`,
    [runId],
  );
  return rows.length === 1;
}

test('a claimed run is not claimable again, so two workers cannot both run it',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'queued' });
    assert.equal(await isClaimable(run.id), true, 'a fresh queued run should be claimable');

    // Claim until we get ours, then assert it cannot be claimed a second time.
    const claimed: string[] = [];
    for (let i = 0; i < 25; i++) {
      const got = await claimOne(`w-${i}`);
      if (!got) break;
      claimed.push(got.id);
      if (got.id === run.id) break;
    }
    assert.ok(claimed.includes(run.id), 'the seeded run was never claimed');
    assert.equal(new Set(claimed).size, claimed.length, 'a run was handed out twice');
    assert.equal(await isClaimable(run.id), false, 'the run is still claimable after a claim');
    await dropRun(run.id);
  });

test('claiming moves a queued run off the queue in the same statement',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'queued' });
    let mine = null;
    for (let i = 0; i < 25 && !mine; i++) {
      const got = await claimOne('w1');
      if (!got) break;
      if (got.id === run.id) mine = got;
    }
    assert.ok(mine, 'the seeded run was never claimed');
    assert.notEqual(mine!.status, 'queued', 'a claimed run must not still read as queued');
    assert.ok(mine!.claimed_at, 'the claim must stamp claimed_at');
    await dropRun(run.id);
  });

test('a lease older than the window is reclaimable', { skip: skipWithoutDatabase },
  async () => {
    const r = await seedRun({
      status: 'researching', claimed_by: 'dead',
      claimed_at: new Date(Date.now() - 20 * 60_000),
    });
    assert.equal(await isClaimable(r.id), true);
    await dropRun(r.id);
  });

test('a fresh lease is not stolen', { skip: skipWithoutDatabase }, async () => {
  const r = await seedRun({ status: 'researching', claimed_by: 'w1', claimed_at: new Date() });
  assert.equal(await isClaimable(r.id), false);
  await dropRun(r.id);
});

test('a finished run is never reclaimed, however old its lease',
  { skip: skipWithoutDatabase }, async () => {
    const r = await seedRun({
      status: 'complete', claimed_by: 'old',
      claimed_at: new Date(Date.now() - 24 * 60 * 60_000),
    });
    assert.equal(await isClaimable(r.id), false);
    await dropRun(r.id);
  });

test('a run parked on a question is never reclaimed, so it cannot loop forever',
  { skip: skipWithoutDatabase }, async () => {
    const r = await seedRun({
      status: 'refining_icp',
      needs_clarification: 'Which country should I search in?',
      claimed_at: new Date(Date.now() - 24 * 60 * 60_000),
    } as any);
    assert.equal(await isClaimable(r.id), false);
    await dropRun(r.id);
  });

/**
 * A paused run is parked, and parked means nothing picks it up.
 *
 * The status of a paused run is whatever stage it stopped in, which is not
 * terminal, so nothing else in the claim predicate excludes it. Without its
 * own clause the lease would go stale fifteen minutes later, a worker would
 * take it straight back, and the pause would last exactly one lease window.
 * This is the same reasoning that keeps a run waiting on a clarification out
 * of the queue.
 */
test('a paused run is never claimed, even once its lease has gone stale',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'researching' });
    await query(
      `update public.runs
          set claimed_at = now() - interval '20 minutes', claimed_by = 'gone',
              paused_at = now()
        where id = $1`, [run.id]);

    assert.equal(await isClaimable(run.id), false, 'a paused run matched the claim predicate');

    const handed: string[] = [];
    for (let i = 0; i < 12; i++) {
      const got = await claimOne(`pause-w-${i}`);
      if (!got) break;
      handed.push(got.id);
    }
    assert.ok(!handed.includes(run.id), 'a paused run was handed to a worker');
    await dropRun(run.id);
  });

test('resuming a paused run puts it back in the queue',
  { skip: skipWithoutDatabase }, async () => {
    const run = await seedRun({ status: 'researching' });
    await query(
      `update public.runs set claimed_at = now(), claimed_by = 'w', paused_at = now()
        where id = $1`, [run.id]);
    assert.equal(await isClaimable(run.id), false);

    /**
     * Exactly what the resume route writes. The status has to go back to
     * `queued` with the lease cleared: the predicate takes a queued run with
     * no claim, or a non-terminal run whose claim has expired, and a run left
     * at `researching` with a null `claimed_at` is neither of those. It would
     * sit unclaimed forever, which is the bug this asserts against.
     */
    await query(
      `update public.runs
          set paused_at = null, paused_by = null,
              status = 'queued', claimed_by = null, claimed_at = null
        where id = $1`, [run.id]);

    assert.equal(await isClaimable(run.id), true, 'a resumed run never became claimable');
    await dropRun(run.id);
  });
