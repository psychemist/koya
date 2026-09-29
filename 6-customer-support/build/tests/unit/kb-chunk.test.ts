import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkMarkdown } from '../../lib/kb/chunk.ts';

const md = readFileSync(new URL('../../../assets/relaypay-knowledge-base.md', import.meta.url), 'utf8');
const chunks = chunkMarkdown(md);
const ids = chunks.map((c) => c.id);

test('the chunks the brief scenarios depend on exist under stable ids', () => {
  for (const id of ['frequently-asked-questions/how-does-relaypay-charge-fees',
                    'frequently-asked-questions/how-long-do-payments-take-to-process',
                    'frequently-asked-questions/can-relaypay-guarantee-payment-timelines',
                    'product-features-overview/feature-availability-and-limitations',
                    'policies-and-compliance/overview'])
    assert.ok(ids.includes(id), `missing ${id}`);
});

test('text under a ## heading before its first ### becomes an overview chunk, not lost', () => {
  const o = chunks.find((c) => c.id === 'policies-and-compliance/overview')!;
  assert.match(o.content, /Anti-Money Laundering/);
});

test('the h1 title and the source line are not knowledge', () => {
  assert.ok(!chunks.some((c) => /exported RelayPay Notion/.test(c.content)));
});

test('ids are unique, content is non-empty, and hashes are stable across runs', () => {
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(chunks.every((c) => c.content.trim().length > 0));
  assert.deepEqual(chunkMarkdown(md).map((c) => c.content_hash), chunks.map((c) => c.content_hash));
});

test('the source summary is the first sentence, capped at 200 characters', () => {
  const fees = chunks.find((c) => c.id.endsWith('how-does-relaypay-charge-fees'))!;
  assert.equal(fees.source_summary, 'Fees vary based on transaction type, corridor, and payment method.');
  assert.ok(chunks.every((c) => c.source_summary.length <= 200));
});

test('between 35 and 60 chunks, so a heading change that shreds the KB is noticed', () => {
  assert.ok(chunks.length >= 35 && chunks.length <= 60, `got ${chunks.length}`);
});
