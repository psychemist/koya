import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../../lib/db.ts';
import { upsertConversation } from '../../lib/conversations.ts';
import { recordSpend, spentToday } from '../../lib/ledger.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

test('one Vapi call id is one conversation, however many events arrive', { skip: skipWithoutDatabase }, async () => {
  const id = `call-${randomUUID()}`;
  const a = await upsertConversation({ vapiCallId: id, channel: 'voice_web' });
  const b = await upsertConversation({ vapiCallId: id, channel: 'voice_web' });
  assert.equal(a.id, b.id);
  await dropConversation(a.id);
});

test('a turn with an unknown answer type is refused by the database', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await assert.rejects(() => query(
    `insert into public.conversation_turns (conversation_id, seq, user_transcript, assistant_response, answer_type, status)
     values ($1, 1, 'x', 'y', 'guess', 'ok')`, [c.id]), /check/);
  await dropConversation(c.id);
});

test('two open tickets with one dedupe key cannot coexist, but a closed one frees the key', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const ins = () => query(`insert into public.support_tickets (conversation_id, category, priority, summary, dedupe_key)
    values ($1,'payment','normal','invoice payment failed', $1::uuid::text || ':payment') returning id`, [c.id]);
  const [t] = await ins();
  await assert.rejects(ins, /unique/);
  await query(`update public.support_tickets set status='closed' where id=$1`, [t.id]);
  await ins();
  await dropConversation(c.id);
});

test('an escalation with a malformed email is refused', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await assert.rejects(() => query(`insert into public.escalations (conversation_id, user_name, user_email, category, reason)
    values ($1,'Efua','efua at accrastack','account','restricted account')`, [c.id]), /check/);
  await dropConversation(c.id);
});

test('ticket references are human readable', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const [t] = await query(`insert into public.support_tickets (conversation_id, category, priority, summary, dedupe_key)
    values ($1,'other','low','reference format check', gen_random_uuid()::text) returning ticket_ref`, [c.id]);
  assert.match(t.ticket_ref, /^RP-T-\d{6}$/);
  await dropConversation(c.id);
});

test('spend is summed for the current UTC day only', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const before = await spentToday('anthropic');
  await recordSpend('anthropic', 0.0123, c.id, 'test');
  assert.ok(Math.abs((await spentToday('anthropic')) - before - 0.0123) < 1e-9);
  await query('delete from public.spend_ledger where conversation_id = $1', [c.id]);
  await dropConversation(c.id);
});
