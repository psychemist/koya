import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureEmbedder, voyageEmbedder } from '../../lib/kb/embed.ts';

test('the fixture embedder is deterministic, unit length, and puts shared words close together', async () => {
  const e = fixtureEmbedder();
  const { vectors: [a, b, c] } = await e.embed(['how does relaypay charge fees', 'what fees do you charge', 'crypto payments'], 'query');
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
  assert.ok(dot(a, b) > dot(a, c));
});

test('voyage is called with input_type and output_dimension, and a non-200 is EMBEDDING_FAILED', async () => {
  const seen: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return new Response('no', { status: 503 }); }) as any;
  try {
    await assert.rejects(() => voyageEmbedder('pa-test').embed(['x'], 'query'), (e: any) => e.code === 'EMBEDDING_FAILED');
    assert.deepEqual([seen[0].input_type, seen[0].output_dimension, seen[0].model], ['query', 1024, 'voyage-3.5-lite']);
  } finally { globalThis.fetch = original; }
});

test('a document batch gets a longer timeout than a live query', async () => {
  const seen: number[] = [];
  const original = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  (AbortSignal as any).timeout = (ms: number) => { seen.push(ms); return originalTimeout.call(AbortSignal, ms); };
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }], usage: { total_tokens: 1 } }), { status: 200 })) as any;
  try {
    await voyageEmbedder('pa-test').embed(['q'], 'query');
    await voyageEmbedder('pa-test').embed(['d'], 'document');
    assert.ok(seen[0] <= 5_000 && seen[1] >= 30_000, JSON.stringify(seen));
  } finally { globalThis.fetch = original; (AbortSignal as any).timeout = originalTimeout; }
});

test('an abort while the body is read is EMBEDDING_FAILED, never an uncaught DOMException', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } })) as any;
  try {
    await assert.rejects(() => voyageEmbedder('pa-test').embed(['x'], 'document'), (e: any) => e.code === 'EMBEDDING_FAILED' && /timeout/i.test(e.message));
  } finally { globalThis.fetch = original; }
});
