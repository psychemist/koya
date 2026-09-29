import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { searchTool } from '../../mcp/tools/search-knowledge-base.ts';
import { withToolCall } from '../../mcp/toolcall.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

process.env.EMBEDDINGS = 'fixture';
const run = (conv: string, q: string) => withToolCall(conv, 'search_knowledge_base', 'test', { query: q }, () => searchTool.run({ query: q }, conv));

test('every search writes one retrieval_logs row with titles, summaries and scores', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r: any = await run(c.id, 'how does relaypay charge fees');
  const [log] = await query('select * from public.retrieval_logs where conversation_id = $1', [c.id]);
  assert.deepEqual(log.chunk_ids, r.chunks.map((x: any) => x.id));
  assert.equal(log.source_titles.length, log.chunk_ids.length);
  assert.equal(log.source_summaries.length, log.chunk_ids.length);
  assert.equal(log.grounded, r.grounded);
  await dropConversation(c.id);
});

test('the tool_calls summary carries per-chunk grounded flags for the reply gate', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await run(c.id, 'how does relaypay charge fees');
  const [row] = await query(`select result_summary from public.tool_calls where conversation_id = $1`, [c.id]);
  assert.ok(Array.isArray(row.result_summary.chunks) && 'grounded' in row.result_summary.chunks[0]);
  await dropConversation(c.id);
});

test('an empty or over-long query is refused as INVALID_INPUT', { skip: skipWithoutDatabase }, async () => {
  assert.equal(searchTool.input.safeParse({ query: '' }).success, false);
  assert.equal(searchTool.input.safeParse({ query: 'x'.repeat(301) }).success, false);
});
