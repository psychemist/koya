import { createHash } from 'node:crypto';
import { ToolError } from '../errors.ts';
import { config } from '../config.ts';

export interface Embedder { model: string; embed(texts: string[], kind: 'document' | 'query'): Promise<{ vectors: number[][]; tokens: number }> }
export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

/** A live query is on the voice path and must fail fast; an ingest batch is not, and is larger. */
const TIMEOUT_MS = { query: 4_000, document: 30_000 } as const;

export function voyageEmbedder(apiKey: string, model = 'voyage-3.5-lite', dims = 1024): Embedder {
  return { model, async embed(texts, kind) {
    // Every failure, including an abort that fires while the body is still being read, is one
    // EMBEDDING_FAILED, so search degrades to full text instead of crashing the caller.
    try {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: dims }),
        signal: AbortSignal.timeout(TIMEOUT_MS[kind]) });
      if (!res.ok) throw new ToolError('EMBEDDING_FAILED', `voyage returned ${res.status}`);
      const j = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage: { total_tokens: number } };
      return { vectors: j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding), tokens: j.usage.total_tokens };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('EMBEDDING_FAILED', `voyage unreachable: ${(e as Error).message}`);
    }
  } };
}

const STOP = new Set(['the','and','for','you','your','does','what','how','can','are','our','with','from','that','this','relaypay','do','is','my','me','i']);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
/** Test double: hashed bag of stemmed words. Deterministic, unit length, no network. */
export function fixtureEmbedder(dims = 1024): Embedder {
  return { model: 'fixture', async embed(texts) {
    const vectors = texts.map((t) => {
      const v = new Array(dims).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        if (STOP.has(w)) continue;
        v[createHash('sha256').update(stem(w)).digest().readUInt32BE(0) % dims] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
    return { vectors, tokens: 0 };
  } };
}

export const embedderFromEnv = (): Embedder =>
  process.env.EMBEDDINGS === 'fixture' ? fixtureEmbedder() : voyageEmbedder(config.kb.voyageKey, config.kb.voyageModel, config.kb.dims);
