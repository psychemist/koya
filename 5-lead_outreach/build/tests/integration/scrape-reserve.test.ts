import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveScrape, releaseScrape } from '../../lib/budget.ts';
import { query } from '../../lib/db.ts';
import { seedRun, dropRun, skipWithoutDatabase } from '../helpers.ts';

/**
 * The scrape budget was checked, not reserved.
 *
 * `clampScrapes(run)` reads a row loaded at the top of the tool call, then the
 * page is fetched, then the counter is incremented. Serially that is fine. The
 * moment the agent issues several scrapes in ONE turn, which is what makes a
 * run fast, every one of them reads the same row, every one sees budget left,
 * and the run overshoots its limit by however many it issued at once.
 *
 * This is the same defect the Apify path already carries a paragraph about.
 */
test('two scrapes racing for one slot: exactly one wins', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun({ scrape_budget: 1, scrapes_used: 0 });

    const results = await Promise.all([reserveScrape(run.id), reserveScrape(run.id)]);
    assert.deepEqual(results.filter(Boolean).length, 1,
      `both calls claimed the last slot: ${JSON.stringify(results)}`);

    const [after] = await query<{ scrapes_used: number }>(
      'select scrapes_used from public.runs where id = $1', [run.id]);
    assert.equal(after.scrapes_used, 1, 'the counter overshot the budget');

    await dropRun(run.id);
  });

test('five racing for three slots: exactly three win', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun({ scrape_budget: 3, scrapes_used: 0 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveScrape(run.id)));
    assert.equal(results.filter(Boolean).length, 3);

    const [after] = await query<{ scrapes_used: number }>(
      'select scrapes_used from public.runs where id = $1', [run.id]);
    assert.equal(after.scrapes_used, 3);

    await dropRun(run.id);
  });

test('an exhausted budget reserves nothing', { skip: skipWithoutDatabase }, async () => {
  const run = await seedRun({ scrape_budget: 2, scrapes_used: 2 });
  assert.equal(await reserveScrape(run.id), false);
  await dropRun(run.id);
});

test('a slot released after a failed fetch is available again',
  { skip: skipWithoutDatabase }, async () => {
    // A page that could not be fetched cost nothing, so it must not cost a
    // slot either, or a run with flaky sites quietly loses its budget.
    const run = await seedRun({ scrape_budget: 1, scrapes_used: 0 });

    assert.equal(await reserveScrape(run.id), true);
    assert.equal(await reserveScrape(run.id), false, 'the single slot was not taken');
    await releaseScrape(run.id);
    assert.equal(await reserveScrape(run.id), true, 'the released slot was not returned');

    await dropRun(run.id);
  });

test('releasing never drops the counter below zero', { skip: skipWithoutDatabase },
  async () => {
    const run = await seedRun({ scrape_budget: 5, scrapes_used: 0 });
    await releaseScrape(run.id);
    const [after] = await query<{ scrapes_used: number }>(
      'select scrapes_used from public.runs where id = $1', [run.id]);
    assert.equal(after.scrapes_used, 0);
    await dropRun(run.id);
  });
