import { query, one, tx } from '../db.ts';
import { sha256 } from '../hash.ts';
import { config } from '../config.ts';
import { recordSpend } from '../ledger.ts';
import { chunkMarkdown } from './chunk.ts';
import { toVectorLiteral, type Embedder } from './embed.ts';

const VOYAGE_USD_PER_TOKEN = 0.02 / 1_000_000; // voyage-3.5-lite list price, checked 2026-09-28
export type ChunkHit = { id: string; source_title: string; heading: string; content: string; source_summary: string;
  similarity: number; fts_rank: number; rrf: number; grounded: boolean };
export type SearchResult = { query: string; chunks: ChunkHit[]; grounded: boolean; degraded: boolean };

export function markGrounded(rows: Omit<ChunkHit, 'grounded'>[], threshold: number, ftsStrong: number, degraded: boolean): ChunkHit[] {
  return rows.map((r) => ({ ...r, grounded: (!degraded && r.similarity >= threshold) || r.fts_rank >= ftsStrong }));
}

async function queryEmbedding(q: string, e: Embedder, conversationId?: string | null): Promise<number[]> {
  const key = sha256(`${e.model}:${q.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()}`);
  const hit = await one<{ embedding: string }>('select embedding::text from public.query_embeddings where query_hash = $1', [key]);
  if (hit) return JSON.parse(hit.embedding);
  const { vectors: [v], tokens } = await e.embed([q], 'query');
  await query(`insert into public.query_embeddings (query_hash, model, embedding) values ($1,$2,$3::extensions.vector)
               on conflict do nothing`, [key, e.model, toVectorLiteral(v)]);
  if (tokens) await recordSpend('voyage', tokens * VOYAGE_USD_PER_TOKEN, conversationId ?? null, 'query embedding');
  return v;
}

export async function searchKb(raw: string, e: Embedder, opts: { matchCount?: number; conversationId?: string | null } = {}): Promise<SearchResult> {
  const q = raw.trim().replace(/\s+/g, ' ');
  let vec: number[] | null = null, degraded = false;
  try { vec = await queryEmbedding(q, e, opts.conversationId); } catch { degraded = true; }
  const rows = await query<Omit<ChunkHit, 'grounded'>>(
    'select * from public.search_kb($1, $2::extensions.vector, $3)', [q, vec ? toVectorLiteral(vec) : null, opts.matchCount ?? 4]);
  const chunks = markGrounded(rows, config.kb.groundingThreshold, config.kb.ftsStrong, degraded);
  return { query: q, chunks, grounded: chunks.some((c) => c.grounded), degraded };
}

export async function ingestKb(md: string, e: Embedder) {
  const chunks = chunkMarkdown(md);
  const existing = new Map((await query<{ id: string; content_hash: string; retired_at: Date | null; embedding_model: string | null }>(
    'select id, content_hash, retired_at, embedding_model from public.kb_chunks')).map((r) => [r.id, r]));
  // A chunk embedded by another model is stale too: vectors from two models are not comparable,
  // and the integration suite's fixture vectors must never survive a real ingest.
  const changed = chunks.filter((c) => { const x = existing.get(c.id);
    return !x || x.content_hash !== c.content_hash || !!x.retired_at || x.embedding_model !== e.model; });
  const { vectors, tokens } = changed.length ? await e.embed(changed.map((c) => `${c.source_title} > ${c.heading}\n${c.content}`), 'document') : { vectors: [], tokens: 0 };
  let inserted = 0, updated = 0;
  await tx(async (db) => {
    for (const [i, c] of changed.entries()) {
      existing.has(c.id) ? updated++ : inserted++;
      await db.query(`insert into public.kb_chunks (id, source_title, heading, content, source_summary, content_hash, embedding, embedding_model)
        values ($1,$2,$3,$4,$5,$6,$7::extensions.vector,$8)
        on conflict (id) do update set source_title=excluded.source_title, heading=excluded.heading, content=excluded.content,
          source_summary=excluded.source_summary, content_hash=excluded.content_hash, embedding=excluded.embedding,
          embedding_model=excluded.embedding_model, retired_at=null, updated_at=now()`,
        [c.id, c.source_title, c.heading, c.content, c.source_summary, c.content_hash, toVectorLiteral(vectors[i]), e.model]);
    }
  });
  const live = new Set(chunks.map((c) => c.id));
  const toRetire = [...existing.values()].filter((r) => !live.has(r.id) && !r.retired_at).map((r) => r.id);
  if (toRetire.length) await query('update public.kb_chunks set retired_at = now() where id = any($1)', [toRetire]);
  if (tokens) await recordSpend('voyage', tokens * VOYAGE_USD_PER_TOKEN, null, 'kb ingest');
  return { inserted, updated, unchanged: chunks.length - changed.length, retired: toRetire.length, tokens };
}
