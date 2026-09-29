import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markGrounded } from '../../lib/kb/search.ts';
import { loadConfig } from '../../lib/config.ts';

const { groundingThreshold, ftsStrong } = loadConfig({}).kb;
const hit = (similarity: number, fts_rank: number) => ({ id: 'x', source_title: '', heading: '', content: '', source_summary: '', similarity, fts_rank, rrf: 0 });

test('a single word matched only in a chunk body never grounds an answer', () => {
  // "Should I invoice in euros for tax reasons?" matched invoicing chunks at 0.1 each (2026-09-29).
  assert.equal(markGrounded([hit(0, 0.1)], groundingThreshold, ftsStrong, true)[0].grounded, false);
});

test('with embeddings down, a query term matching the FAQ heading still grounds', () => {
  assert.equal(markGrounded([hit(0, 1.2)], groundingThreshold, ftsStrong, true)[0].grounded, true);
});

test('a vector similarity at the threshold grounds, and a degraded search ignores similarity', () => {
  assert.equal(markGrounded([hit(0.5, 0)], groundingThreshold, ftsStrong, false)[0].grounded, true);
  assert.equal(markGrounded([hit(0.9, 0)], groundingThreshold, ftsStrong, true)[0].grounded, false);
  assert.equal(markGrounded([hit(0.49, 0)], groundingThreshold, ftsStrong, false)[0].grounded, false);
});
