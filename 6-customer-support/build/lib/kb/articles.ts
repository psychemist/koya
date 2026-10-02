import { query } from '../db.ts';
import { recordSpend } from '../ledger.ts';
import { chunkMarkdown } from './chunk.ts';
import { toVectorLiteral, type Embedder } from './embed.ts';
import { CONSOLE_PREFIX, VOYAGE_USD_PER_TOKEN } from './search.ts';

export type ConsoleArticle = { id: string; heading: string; content: string; updated_at: string; retired: boolean };
const SECTION = 'Console articles';   // chunkMarkdown slugs this to the console-articles/ prefix

/**
 * An article an admin adds in the console becomes one knowledge base chunk, embedded the same way as the file,
 * so the agent's search finds it and the reply gate grounds on it like any other chunk. Its id is
 * console-articles/<slug of the title>, so adding the same title again replaces it rather than duplicating it.
 */
export async function addArticle(title: string, body: string, e: Embedder): Promise<{ id: string; replaced: boolean }> {
  const [chunk] = chunkMarkdown(`## ${SECTION}\n\n### ${title}\n\n${body}`);
  if (!chunk || !chunk.id.startsWith(CONSOLE_PREFIX) || chunk.id === `${CONSOLE_PREFIX}overview`) throw new Error('The title needs letters or numbers.');
  const { vectors, tokens } = await e.embed([`${chunk.source_title} > ${chunk.heading}\n${chunk.content}`], 'document');
  const r = await query<{ replaced: boolean }>(
    `insert into public.kb_chunks (id, source_title, heading, content, source_summary, content_hash, embedding, embedding_model)
     values ($1,$2,$3,$4,$5,$6,$7::extensions.vector,$8)
     on conflict (id) do update set heading=excluded.heading, content=excluded.content, source_summary=excluded.source_summary,
       content_hash=excluded.content_hash, embedding=excluded.embedding, embedding_model=excluded.embedding_model, retired_at=null, updated_at=now()
     returning (xmax <> 0) as replaced`,
    [chunk.id, chunk.source_title, chunk.heading, chunk.content, chunk.source_summary, chunk.content_hash, toVectorLiteral(vectors[0]), e.model]);
  if (tokens) await recordSpend('voyage', tokens * VOYAGE_USD_PER_TOKEN, null, 'console article');
  return { id: chunk.id, replaced: !!r[0]?.replaced };
}

/** Takes an article out of search without deleting it, so a mistake can be put back by adding it again. */
export async function retireArticle(id: string): Promise<boolean> {
  if (!id.startsWith(CONSOLE_PREFIX)) return false;
  const r = await query('update public.kb_chunks set retired_at = now() where id = $1 and retired_at is null returning id', [id]);
  return r.length > 0;
}

export async function listArticles(): Promise<{ articles: ConsoleArticle[]; fileChunks: number }> {
  const [rows, file] = await Promise.all([
    query<any>(`select id, heading, content, updated_at, retired_at is not null as retired from public.kb_chunks
      where id like $1 order by retired_at is not null, updated_at desc`, [`${CONSOLE_PREFIX}%`]),
    query<{ n: number }>(`select count(*)::int as n from public.kb_chunks where id not like $1 and retired_at is null`, [`${CONSOLE_PREFIX}%`]),
  ]);
  return { articles: rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() })), fileChunks: file[0]?.n ?? 0 };
}
