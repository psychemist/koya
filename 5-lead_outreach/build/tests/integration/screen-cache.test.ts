import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readScreenCache, writeScreenCache } from '../../lib/screen/cache.ts';
import { query } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

/**
 * A cached page was free of Firecrawl cost and not free: the injection screen
 * ran on every scrape call regardless, so re-reading a page already on disk
 * still cost a model call.
 */
const hash = () => `test-${randomUUID()}`;

test('a screened page is not screened again', { skip: skipWithoutDatabase }, async () => {
  const h = hash();
  assert.equal(await readScreenCache(h), null);

  await writeScreenCache(h, {
    summary: 'A payroll product sold to UK accountants.',
    flagged: false, reason: undefined, usable: true,
  });

  const hit = await readScreenCache(h);
  assert.equal(hit?.summary, 'A payroll product sold to UK accountants.');
  assert.equal(hit?.flagged, false);

  await query('delete from public.screen_cache where content_hash = $1', [h]);
});

test('a flagged page stays flagged when it is served from cache',
  { skip: skipWithoutDatabase }, async () => {
    // Losing the flag would hand the agent an excerpt the quarantine refused.
    const h = hash();
    await writeScreenCache(h, {
      summary: '', flagged: true, reason: 'addressed an automated reader', usable: true,
    });

    const hit = await readScreenCache(h);
    assert.equal(hit?.flagged, true);
    assert.match(hit!.reason!, /automated reader/);

    await query('delete from public.screen_cache where content_hash = $1', [h]);
  });

test('a screen that produced nothing usable is never cached',
  { skip: skipWithoutDatabase }, async () => {
    // One malformed model response would otherwise become permanent for that
    // page, and the quarantine would hand the agent nothing for ever.
    const h = hash();
    await writeScreenCache(h, {
      summary: '', flagged: true, reason: 'screen returned malformed output', usable: false,
    });
    assert.equal(await readScreenCache(h), null, 'a failed screen was cached');
  });

test('different bytes are a different screening job', { skip: skipWithoutDatabase },
  async () => {
    const a = hash();
    await writeScreenCache(a, { summary: 'first', flagged: false, usable: true });
    assert.equal(await readScreenCache(hash()), null);
    await query('delete from public.screen_cache where content_hash = $1', [a]);
  });
