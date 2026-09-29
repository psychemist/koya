import { z } from 'zod/v4';
import { query } from '../../lib/db.ts';
import { searchKb } from '../../lib/kb/search.ts';
import { embedderFromEnv } from '../../lib/kb/embed.ts';
import type { ToolSpec } from '../define.ts';

const input = z.object({ query: z.string().trim().min(1).max(300).describe('The caller question, rephrased as a search query.') });

export const searchTool: ToolSpec<typeof input> = {
  name: 'search_knowledge_base',
  description: 'Search approved RelayPay support knowledge. Call before answering any product or policy question. ' +
    'Only chunks with grounded: true may support an answer; cite their ids.',
  input, readOnly: true,
  async run({ query: q }, conversationId) {
    const r = await searchKb(q, embedderFromEnv(), { conversationId });
    await query(`insert into public.retrieval_logs (conversation_id, query, chunk_ids, source_titles, source_summaries, scores, grounded, degraded)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [conversationId, r.query, r.chunks.map((c) => c.id), r.chunks.map((c) => c.source_title), r.chunks.map((c) => c.source_summary),
       JSON.stringify(r.chunks.map(({ id, similarity, fts_rank, rrf, grounded }) => ({ id, similarity, fts_rank, rrf, grounded }))),
       r.grounded, r.degraded]);
    return {
      result: { grounded: r.grounded, degraded: r.degraded, chunks: r.chunks.map((c) => ({ id: c.id, source_title: c.source_title,
        heading: c.heading, content: c.content, source_summary: c.source_summary, score: Number(c.similarity.toFixed(3)), grounded: c.grounded })) },
      summary: { grounded: r.grounded, degraded: r.degraded, chunks: r.chunks.map((c) => ({ id: c.id, grounded: c.grounded, similarity: c.similarity })) },
    };
  },
};
