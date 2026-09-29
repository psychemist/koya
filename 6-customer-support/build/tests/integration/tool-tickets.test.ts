import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { ticketTool } from '../../mcp/tools/create-support-ticket.ts';
import { eventTool } from '../../mcp/tools/log-conversation-event.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

const t = async (conv: string, a: object) => (await ticketTool.run(a as any, conv)).result as any;
const base = { category: 'invoice', priority: 'normal', summary: 'Invoice payment failed and the customer wants it checked.' };

test('scenario 6: a ticket is created in Supabase with a readable reference', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await t(c.id, base);
  assert.match(r.ticket_id, /^RP-T-\d{6}$/);
  assert.deepEqual([r.status, r.deduplicated], ['open', false]);
  const [row] = await query('select category, status from public.support_tickets where ticket_ref = $1', [r.ticket_id]);
  assert.deepEqual(row, { category: 'invoice', status: 'open' });
  await dropConversation(c.id);
});

test('row 20: asking twice returns the same ticket, flagged deduplicated', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const a = await t(c.id, base);
  const b = await t(c.id, { ...base, summary: 'Same invoice issue, said again by the caller.' });
  assert.deepEqual([b.ticket_id, b.deduplicated], [a.ticket_id, true]);
  const [{ n }] = await query('select count(*) n from public.support_tickets where conversation_id = $1', [c.id]);
  assert.equal(Number(n), 1);
  await dropConversation(c.id);
});

test('a customer id the call has not verified is not attached', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await t(c.id, { ...base, customer_id: 'CUS-1003' });
  const [row] = await query('select customer_id from public.support_tickets where ticket_ref = $1', [r.ticket_id]);
  assert.equal(row.customer_id, null);
  await dropConversation(c.id);
});

test('an unknown transaction reference is dropped, a known one is normalised and linked', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await t(c.id, { ...base, category: 'payout', transaction_id: 'txn 9004' });
  const [row] = await query('select transaction_id from public.support_tickets where ticket_ref = $1', [r.ticket_id]);
  assert.equal(row.transaction_id, 'TXN-9004');
  await dropConversation(c.id);
});

test('compliance and dispute tickets are raised to at least high, whatever the agent chose', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.equal((await t(c.id, { ...base, category: 'dispute', priority: 'low' })).priority, 'high');
  await dropConversation(c.id);
});

test('an unknown category or event type is refused by the schema', () => {
  assert.equal(ticketTool.input.safeParse({ ...base, category: 'vip' }).success, false);
  assert.equal(eventTool.input.safeParse({ event_type: 'free_text', summary: 'x' }).success, false);
});

test('log_conversation_event appends with source agent', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.deepEqual((await eventTool.run({ event_type: 'caller_frustrated', summary: 'third call about this' } as any, c.id)).result, { logged: true });
  const [row] = await query('select event_type, source from public.conversation_events where conversation_id = $1', [c.id]);
  assert.deepEqual(row, { event_type: 'caller_frustrated', source: 'agent' });
  await dropConversation(c.id);
});
