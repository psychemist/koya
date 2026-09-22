import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimOne } from '../../worker/index.ts';
import { query } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/** These tests share one claim queue, so each clears the decks first. A run
 *  left queued by another test would be claimed here and look like a pass. */
async function clearQueue() {
  await query(
    `update public.runs set status = 'failed'
      where status not in ('complete','partial','failed')`);
}

test('two workers racing claim different runs, never the same one',
  { skip: skipWithoutDatabase }, async () => {
    await clearQueue();
    const a = await seedRun({ status: 'queued' });
    const b = await seedRun({ status: 'queued' });
    const [x, y] = await Promise.all([claimOne('w1'), claimOne('w2')]);
    assert.ok(x && y && x.id !== y.id);
    await dropRun(a.id); await dropRun(b.id);
  });

test('a lease older than the window is reclaimable', { skip: skipWithoutDatabase },
  async () => {
    await clearQueue();
    const r = await seedRun({
      status: 'researching', claimed_by: 'dead',
      claimed_at: new Date(Date.now() - 20 * 60_000),
    });
    assert.equal((await claimOne('w2'))?.id, r.id);
    await dropRun(r.id);
  });

test('a fresh lease is not stolen', { skip: skipWithoutDatabase }, async () => {
  await clearQueue();
  const r = await seedRun({ status: 'researching', claimed_by: 'w1', claimed_at: new Date() });
  assert.equal(await claimOne('w2'), null);
  await dropRun(r.id);
});

test('a finished run is never reclaimed, however old its lease',
  { skip: skipWithoutDatabase }, async () => {
    await clearQueue();
    const r = await seedRun({
      status: 'complete', claimed_by: 'old',
      claimed_at: new Date(Date.now() - 24 * 60 * 60_000),
    });
    assert.equal(await claimOne('w2'), null);
    await dropRun(r.id);
  });
