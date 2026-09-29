import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oneRowPerUrl } from '../../app/ui/lead-pages.ts';
import { percent } from '../../app/ui/format.ts';

/**
 * The two things the run page got wrong on 2026-09-29, kept wrong on purpose
 * here so they cannot come back quietly.
 *
 * A run stored two `scraped_pages` rows for https://wyzeai.com.ng, because
 * nothing stops a page being fetched twice and a reclaimed run re-reads what
 * the first session read. The page keyed its excerpts by URL, so React was
 * handed two children with the same key and said so in the console. A warning
 * is the polite version: the documented behaviour is that children may be
 * duplicated or omitted.
 */
test('two rows for one URL render as one page', () => {
  const rows = [
    { url: 'https://wyzeai.com.ng', screened_summary: 'first read' },
    { url: 'https://wyzeai.com.ng', screened_summary: 'second read' },
    { url: 'https://wyzeai.com.ng/about', screened_summary: 'about page' },
  ];
  const kept = oneRowPerUrl(rows);
  assert.equal(kept.length, 2);
  assert.equal(new Set(kept.map((p) => p.url)).size, kept.length, 'a URL repeats');
});

test('the screened row wins, because the other one has nothing to show', () => {
  const kept = oneRowPerUrl([
    { url: 'https://acme.test', screened_summary: null },
    { url: 'https://acme.test', screened_summary: 'what the page said' },
  ]);
  assert.deepEqual(kept, [{ url: 'https://acme.test', screened_summary: 'what the page said' }]);

  // And the other way round: a later unscreened row must not displace a good one.
  const keptReversed = oneRowPerUrl([
    { url: 'https://acme.test', screened_summary: 'what the page said' },
    { url: 'https://acme.test', screened_summary: null },
  ]);
  assert.equal(keptReversed[0]!.screened_summary, 'what the page said');
});

test('order is preserved, so the evidence reads in the order it was fetched', () => {
  const kept = oneRowPerUrl([
    { url: 'https://a.test', screened_summary: 'a' },
    { url: 'https://b.test', screened_summary: 'b' },
    { url: 'https://a.test', screened_summary: 'a again' },
  ]);
  assert.deepEqual(kept.map((p) => p.url), ['https://a.test', 'https://b.test']);
});

/**
 * Confidence is stored as a fraction and read as a percentage. The rounding is
 * asserted because a value that rounds to the 40% floor must not be the only
 * thing telling a reviewer which side of it the lead falls on.
 */
test('confidence reads as a percentage', () => {
  assert.equal(percent(0.55), '55%');
  assert.equal(percent('0.4'), '40%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(0.396), '40%');
  assert.equal(percent(0), '0%');
});

test('a confidence that is not a number says so rather than printing NaN', () => {
  assert.equal(percent(null), 'unknown');
  assert.equal(percent(undefined), 'unknown');
  assert.equal(percent('not a number'), 'unknown');
});
