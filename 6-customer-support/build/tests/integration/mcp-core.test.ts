import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { ToolError } from '../../lib/errors.ts';
import { withToolCall } from '../../mcp/toolcall.ts';
import { resolveConversation } from '../../mcp/context.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

test('a throwing handler still leaves a tool_calls row, marked error with its code', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await assert.rejects(() => withToolCall(c.id, 'lookup_transaction', 'check status', { transaction_id: 'TXN-9001' },
    async () => { throw new ToolError('DB_ERROR', 'connection reset'); }));
  const [row] = await query('select status, error_code, error_message, duration_ms from public.tool_calls where conversation_id = $1', [c.id]);
  assert.deepEqual([row.status, row.error_code], ['error', 'DB_ERROR']);
  assert.ok(row.duration_ms >= 0);
  await dropConversation(c.id);
});

test('a refusal is logged as denied, not error', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await assert.rejects(() => withToolCall(c.id, 'create_escalation', 'book', {}, async () => { throw new ToolError('OUTSIDE_HOURS', 'Sunday'); }));
  const [row] = await query('select status from public.tool_calls where conversation_id = $1', [c.id]);
  assert.equal(row.status, 'denied');
  await dropConversation(c.id);
});

test('a secret in a tool input never reaches the log', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await withToolCall(c.id, 't', 'p', { note: 'my key is sk-ant-api03-SECRETSECRET' }, async () => ({ result: {}, summary: {} }));
  const [row] = await query('select input_summary from public.tool_calls where conversation_id = $1', [c.id]);
  assert.ok(!JSON.stringify(row.input_summary).includes('SECRETSECRET'));
  await dropConversation(c.id);
});

test('the transport header wins over the model argument, and the mismatch is reported', { skip: skipWithoutDatabase }, async () => {
  const a = await newConversation(); const b = await newConversation();
  const r = await resolveConversation({ conversationId: a.id, fault: null }, b.id);
  assert.deepEqual(r, { id: a.id, mismatch: true });
  await dropConversation(a.id); await dropConversation(b.id);
});

test('with no header and no argument, an mcp_direct conversation is created so direct use is logged', { skip: skipWithoutDatabase }, async () => {
  const r = await resolveConversation({ conversationId: null, fault: null });
  const [row] = await query('select channel from public.conversations where id = $1', [r.id]);
  assert.equal(row.channel, 'mcp_direct');
  await dropConversation(r.id);
});

test('a header naming a conversation that does not exist is refused', { skip: skipWithoutDatabase }, async () => {
  await assert.rejects(() => resolveConversation({ conversationId: '00000000-0000-0000-0000-000000000000', fault: null }),
    (e: any) => e.code === 'CONVERSATION_UNKNOWN');
});
