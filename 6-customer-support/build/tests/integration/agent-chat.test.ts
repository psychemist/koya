import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { LINES } from '../../lib/lines.ts';
import { finalizeStale } from '../../lib/conversations.ts';
import { createAgentServer } from '../../agent/http.ts';
import { SessionManager } from '../../agent/sessions.ts';
import { queueRuntime } from '../fakes/runtime.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

process.env.AGENT_INTERNAL_TOKEN ??= 'internal-test';
const say = (spoken: string) => ({ kind: 'result', ok: true, costUsd: 0.001, durationMs: 5,
  output: { answer_type: 'clarify', spoken_response: spoken, citations: [], confidence_note: 'test', escalation_category: null } }) as const;
const q = queueRuntime();
const sessions = new SessionManager(q.runtime, { max: 3 });
let server: any, base = '';
before(async () => { server = createAgentServer({ sessions }); await new Promise<void>((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const chat = (body: object) => fetch(`${base}/chat`, { method: 'POST',
  headers: { authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'web_text', ...body }) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const turnsOf = (id: string) => query<{ seq: number; user_transcript: string }>(
  'select seq, user_transcript from public.conversation_turns where conversation_id = $1 order by seq', [id]);

test('the filler never reaches a chat reply', { skip: skipWithoutDatabase }, async () => {
  q.next(() => [{ kind: 'tool_start', tool: 'mcp__relaypay__search_knowledge_base' }, say('Is it incoming, outgoing, or an invoice payment?')]);
  const r = await chat({ message: 'my payment is stuck' });
  assert.equal(r.json.reply, 'Is it incoming, outgoing, or an invoice payment?');
  await dropConversation(r.json.conversation_id);
});

test('row 25: after the warm session is gone, the next message carries the stored turns as prior transcript', { skip: skipWithoutDatabase }, async () => {
  const a = await chat({ message: 'My payout PAY-7003 failed' });
  await sessions.close(a.json.conversation_id);
  await chat({ conversation_id: a.json.conversation_id, message: 'What should I do?' });
  const last = q.prompts.at(-1)!;
  assert.match(last, /\[Prior transcript, for context only\][\s\S]*Caller: My payout PAY-7003 failed/);
  assert.match(last, /\[Channel: web chat\]/);
  await dropConversation(a.json.conversation_id);
});

test('a warm session gets no prior transcript, because it already holds the context', { skip: skipWithoutDatabase }, async () => {
  const a = await chat({ message: 'hello' });
  await chat({ conversation_id: a.json.conversation_id, message: 'are you still there?' });
  assert.doesNotMatch(q.prompts.at(-1)!, /Prior transcript/);
  await dropConversation(a.json.conversation_id);
});

test('a chat cannot continue a voice conversation, or one that does not exist', { skip: skipWithoutDatabase }, async () => {
  const v = await newConversation({ channel: 'voice_web' });
  assert.equal((await chat({ conversation_id: v.id, message: 'hi' })).status, 404);
  assert.equal((await chat({ conversation_id: '00000000-0000-0000-0000-000000000000', message: 'hi' })).status, 404);
  assert.deepEqual(await turnsOf(v.id), []);
  await dropConversation(v.id);
});

test('row 27: an ended chat refuses a new message with 409 and writes nothing', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'web_text' });
  await query(`update public.conversations set ended_at = now(), ended_reason = 'test' where id = $1`, [c.id]);
  const before = q.prompts.length;
  const r = await chat({ conversation_id: c.id, message: 'hello again' });
  assert.deepEqual([r.status, r.json.error, q.prompts.length], [409, 'conversation_ended', before]);
  assert.deepEqual(await turnsOf(c.id), []);
  await dropConversation(c.id);
});

test('the chat goodbye ends and finalises the conversation', { skip: skipWithoutDatabase }, async () => {
  q.next(() => [say(`Glad I could help. ${LINES.chatGoodbye}`)]);
  const r = await chat({ message: 'thanks, that is all' });
  assert.equal(r.json.ended, true);
  const [row] = await query('select ended_at, ended_reason from public.conversations where id = $1', [r.json.conversation_id]);
  assert.ok(row.ended_at);
  assert.equal(row.ended_reason, 'customer-ended-chat');
  assert.equal(sessions.has(r.json.conversation_id), false);
  await dropConversation(r.json.conversation_id);
});

test('the reference note comes from the ticket row, not from the model', { skip: skipWithoutDatabase }, async () => {
  q.next(async (_text, conv) => {
    // Stands in for the MCP server writing a ticket during the turn.
    await query(`insert into public.support_tickets (conversation_id, category, priority, summary, dedupe_key)
      values ($1, 'invoice', 'normal', 'Invoice payment failed and the customer wants it checked.', $1::uuid::text || ':invoice')`, [conv]);
    return [say('I have logged that for a specialist to review.')];
  });
  const r = await chat({ message: 'please log my failed invoice payment' });
  assert.match(r.json.records.ticket_ref, /^RP-T-\d{6}$/);
  assert.deepEqual([r.json.records.escalation_ref, r.json.records.call_booked], [null, false]);
  await dropConversation(r.json.conversation_id);
});

test('over the per-conversation budget, the limit line is returned with no model call', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'web_text' });
  await query('update public.conversations set cost_usd = 0.25 where id = $1', [c.id]);
  const before = q.prompts.length;
  const r = await chat({ conversation_id: c.id, message: 'one more question' });
  assert.deepEqual([r.json.reply, r.json.status, q.prompts.length], [LINES.limitReached, 'capacity', before]);
  await dropConversation(c.id);
});

test('eval conversations are framed as voice, because the brief grades the voice agent', { skip: skipWithoutDatabase }, async () => {
  const r = await chat({ channel: 'eval', message: 'hello' });
  assert.match(q.prompts.at(-1)!, /\[Channel: voice call\]/);
  await dropConversation(r.json.conversation_id);
});

test('Review Focus 6: two messages at once on one chat become two ordered turns, each answered', { skip: skipWithoutDatabase }, async () => {
  const a = await chat({ message: 'first' });
  const id = a.json.conversation_id;
  const [x, y] = await Promise.all([chat({ conversation_id: id, message: 'second' }), chat({ conversation_id: id, message: 'third' })]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  const t = await turnsOf(id);
  assert.deepEqual(t.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(new Set(t.slice(1).map((r) => r.user_transcript)), new Set(['second', 'third']));
  await dropConversation(id);
});

test('row 28 and Review Focus 7: a chat idle for 31 minutes is finalised as idle_timeout; one idle for 5 is not', { skip: skipWithoutDatabase }, async () => {
  const old = await newConversation({ channel: 'web_text' });
  const fresh = await newConversation({ channel: 'web_text' });
  await query(`update public.conversations set started_at = now() - interval '31 minutes' where id = $1`, [old.id]);
  await query(`update public.conversations set started_at = now() - interval '5 minutes' where id = $1`, [fresh.id]);
  const ids = (await finalizeStale(new Date(), { textIdleMs: 30 * 60_000, voiceMaxMs: 20 * 60_000 })).map((s) => s.id);
  assert.ok(ids.includes(old.id));
  assert.ok(!ids.includes(fresh.id));
  const [row] = await query('select ended_reason, final_status from public.conversations where id = $1', [old.id]);
  assert.deepEqual(row, { ended_reason: 'idle_timeout', final_status: 'abandoned' });
  await dropConversation(old.id); await dropConversation(fresh.id);
});

test('a chat whose last turn is recent is not idle, however long ago it started', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'web_text' });
  await query(`update public.conversations set started_at = now() - interval '2 hours' where id = $1`, [c.id]);
  await query(`insert into public.conversation_turns (conversation_id, seq, user_transcript, assistant_response, answer_type, status)
    values ($1, 1, 'still here', 'Could you tell me more?', 'clarify', 'ok')`, [c.id]);
  const ids = (await finalizeStale(new Date(), { textIdleMs: 30 * 60_000, voiceMaxMs: 20 * 60_000 })).map((s) => s.id);
  assert.ok(!ids.includes(c.id));
  await dropConversation(c.id);
});
