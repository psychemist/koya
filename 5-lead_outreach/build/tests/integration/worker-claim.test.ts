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
