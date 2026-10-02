import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureEmbedder } from '../../lib/kb/embed.ts';
import { ingestKb, searchKb } from '../../lib/kb/search.ts';
import { skipWithoutDatabase } from '../helpers.ts';

const md = readFileSync(new URL('../../../assets/relaypay-knowledge-base.md', import.meta.url), 'utf8');
const e = fixtureEmbedder();
before(async () => { if (!skipWithoutDatabase) await ingestKb(md, e); });

test('ingesting twice embeds nothing the second time', { skip: skipWithoutDatabase }, async () => {
  const r = await ingestKb(md, e);
  assert.deepEqual([r.inserted, r.updated, r.tokens], [0, 0, 0]);
});

test('a removed chunk is retired, not deleted, and a restored one comes back', { skip: skipWithoutDatabase }, async () => {
  const trimmed = md.replace(/### Are Exchange Rates Fixed\?[\s\S]*?(?=### )/, '');
  assert.equal((await ingestKb(trimmed, e)).retired, 1);
  await ingestKb(md, e);
  const r = await searchKb('are exchange rates fixed', e);
  assert.ok(r.chunks.some((c) => c.id.endsWith('are-exchange-rates-fixed')));
});

test('the fees question finds the fees chunk first', { skip: skipWithoutDatabase }, async () => {
  const r = await searchKb('What fees does RelayPay charge for international payments?', e);
  assert.equal(r.chunks[0].id, 'frequently-asked-questions/how-does-relaypay-charge-fees');
});

test('a full-text term like crypto is found even when the vector is weak', { skip: skipWithoutDatabase }, async () => {
  const r = await searchKb('crypto', e);
  assert.ok(r.chunks.some((c) => c.id === 'product-features-overview/feature-availability-and-limitations'));
});

test('an unrelated question is not grounded', { skip: skipWithoutDatabase }, async () => {
  const r = await searchKb('what is the weather in Lisbon', e);
  assert.equal(r.grounded, false);
});

test('when embeddings fail, search degrades to full text and says so', { skip: skipWithoutDatabase }, async () => {
  const broken = { model: 'broken', embed: async () => { throw new Error('down'); } };
  const r = await searchKb('crypto payments', broken as any);
  assert.equal(r.degraded, true);
  assert.ok(r.chunks.length > 0);
});

test('a repeated query is served from the cache with no embedding call', { skip: skipWithoutDatabase }, async () => {
  let calls = 0;
  const counting = { model: e.model, embed: async (t: string[], k: any) => { calls++; return e.embed(t, k); } };
  const nonce = Math.random().toString(36).slice(2, 10);   // query_embeddings persists across runs
  await searchKb(`how long do payouts take ${nonce}`, counting as any);
  await searchKb(`How long do payouts take ${nonce}?`, counting as any);
  assert.equal(calls, 1);
});

test('switching embedders re-embeds every chunk, so fixture vectors never outlive a real ingest', { skip: skipWithoutDatabase }, async () => {
  const other = { model: 'fixture-b', embed: e.embed } as any;
  const r = await ingestKb(md, other);
  assert.ok(r.updated > 30, `re-embedded ${r.updated}`);
  assert.equal((await ingestKb(md, e)).updated, r.updated);
});

test('vectors from another model are never scored: the search degrades to full text and says so', { skip: skipWithoutDatabase }, async () => {
  // 2026-10-02: the suite had left fixture vectors in the live table, and Voyage query vectors were
  // scored against them, quietly grounding answers on text matches alone.
  const other = { model: 'some-other-model', embed: e.embed } as any;
  const r = await searchKb('What fees does RelayPay charge for international payments?', other);
  assert.equal(r.degraded, true);
  assert.ok(r.chunks.every((c) => c.similarity === 0), JSON.stringify(r.chunks.map((c) => c.similarity)));
  assert.ok(r.chunks.length > 0, 'full text still finds the fees chunk');
});
