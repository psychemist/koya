import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, one } from '../../lib/db.ts';
import { LINES } from '../../lib/lines.ts';
import { createAgentServer } from '../../agent/http.ts';
import { SessionManager } from '../../agent/sessions.ts';
import type { AgentRuntime, RuntimeEvent } from '../../agent/runtime.ts';
import { skipWithoutDatabase, dropConversation } from '../helpers.ts';

// Assigned, not defaulted: .env.local carries the real secrets, and these tests send these.
Object.assign(process.env, { VAPI_CUSTOM_LLM_KEY: 'llm-test', VAPI_WEBHOOK_SECRET: 'hook-test', AGENT_INTERNAL_TOKEN: 'internal-test' });

const reply = (spoken: string, answer_type = 'clarify'): RuntimeEvent => ({ kind: 'result', ok: true, costUsd: 0.001, durationMs: 5,
  output: { answer_type, spoken_response: spoken, citations: [], confidence_note: 'test', escalation_category: null } });

/** Records what each session was opened with, and lets a test hold a turn open. */
function recordingRuntime() {
  const opened: { id: string; opts: any }[] = [];
  let hold: Promise<void> | null = null;
  const runtime: AgentRuntime = { async open(id, opts = {}) { opened.push({ id, opts }); return {
    conversationId: id, model: 'fake',
    async *turn() { if (hold) await hold; yield reply('Is it incoming, outgoing, or an invoice payment?'); },
    async interrupt() {}, async close() {},
  }; } };
  return { runtime, opened, holdNext() { let release!: () => void; hold = new Promise((r) => { release = () => { hold = null; r(); }; }); return release; } };
}

const rec = recordingRuntime();
const sessions = new SessionManager(rec.runtime, { max: 3 });
let server: ReturnType<typeof createAgentServer>, base = '';
before(async () => { server = createAgentServer({ sessions }); await new Promise<void>((r) => server.listen(0, r)); base = `http://127.0.0.1:${(server.address() as any).port}`; });
after(async () => { await sessions.closeAll(); server.close(); });

const completion = (callId: string, text: string, key = 'llm-test') => fetch(`${base}/vapi/chat/completions`, { method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ call: { id: callId, type: 'webCall' }, messages: [{ role: 'assistant', content: 'Hi, how can I help?' }, { role: 'user', content: text }] }) });
const event = (message: object, secret = 'hook-test') => fetch(`${base}/vapi/events`, { method: 'POST',
  headers: { 'x-vapi-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
const chat = (body: object) => fetch(`${base}/chat`, { method: 'POST',
  headers: { authorization: 'Bearer internal-test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const convFor = (callId: string) => one<any>('select * from public.conversations where vapi_call_id = $1', [callId]);
const frames = (sse: string) => sse.trim().split('\n\n');
const text = (sse: string) => frames(sse).filter((f) => f.startsWith('data: {')).map((f) => JSON.parse(f.slice(6)).choices[0].delta.content ?? '').join('');

test('custom-llm without the bearer key is 401, and the webhook without X-Vapi-Secret is 401', async () => {
  assert.equal((await completion(`call-${randomUUID()}`, 'hi', 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/vapi/chat/completions`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await event({ type: 'status-update' }, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/vapi/events`, { method: 'POST', body: '{}' })).status, 401);
});

test('the webhook also accepts the secret as Authorization: Bearer, which is how a Vapi Bearer Token credential sends it', async () => {
  const send = (auth: string) => fetch(`${base}/vapi/events`, { method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ message: { type: 'status-update' } }) });
  assert.equal((await send('Bearer hook-test')).status, 200);
  assert.equal((await send('Bearer wrong')).status, 401);
  assert.equal((await send('hook-test')).status, 401);
});

test('a Vapi turn streams the reply as SSE and records the conversation with channel voice_web', { skip: skipWithoutDatabase }, async () => {
  const callId = `call-${randomUUID()}`;
  const res = await completion(callId, 'My payment is stuck.');
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const body = await res.text();
  assert.equal(text(body).trim(), 'Is it incoming, outgoing, or an invoice payment?');
  assert.equal(frames(body).at(-1), 'data: [DONE]');
  const c = await convFor(callId);
  assert.equal(c.channel, 'voice_web');
  const [t] = await query('select user_transcript, answer_type from public.conversation_turns where conversation_id = $1', [c.id]);
  assert.deepEqual(t, { user_transcript: 'My payment is stuck.', answer_type: 'clarify' });
  await sessions.close(c.id); await dropConversation(c.id);
});

test('over MAX_CONCURRENT_CALLS, a new call hears the capacity line and goodbye, and an event is logged', { skip: skipWithoutDatabase }, async () => {
  const small = new SessionManager(rec.runtime, { max: 1 });
  const s2 = createAgentServer({ sessions: small }); await new Promise<void>((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${(s2.address() as any).port}`;
  const post = (id: string) => fetch(`${b2}/vapi/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer llm-test' },
    body: JSON.stringify({ call: { id, type: 'webCall' }, messages: [{ role: 'user', content: 'hello there' }] }) }).then((r) => r.text());
  const a = `call-${randomUUID()}`, b = `call-${randomUUID()}`;
  await post(a);
  const refused = await post(b);
  assert.equal(text(refused).trim(), `${LINES.capacity} ${LINES.goodbye}`);
  const cb = await convFor(b);
  const [ev] = await query(`select event_type from public.conversation_events where conversation_id = $1`, [cb.id]);
  assert.equal(ev.event_type, 'capacity_refused');
  await small.closeAll(); s2.close();
  await dropConversation((await convFor(a)).id); await dropConversation(cb.id);
});

test('Review Focus 4: end-of-call-report during a running turn waits for it, then finalises once with the turn counted', { skip: skipWithoutDatabase }, async () => {
  const callId = `call-${randomUUID()}`;
  const release = rec.holdNext();
  const running = completion(callId, 'What is happening with my payout?').then((r) => r.text());
  let c: any = null;
  for (let i = 0; i < 100 && !(c = await convFor(callId)); i++) await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 100 && !sessions.isInFlight(c.id); i++) await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const ack = await event({ type: 'end-of-call-report', endedReason: 'customer-ended-call', call: { id: callId } });
  assert.equal(ack.status, 200);
  assert.ok(Date.now() - t0 < 1000, 'the webhook answers within a second');
  assert.equal((await convFor(callId)).ended_at, null);
  release();
  await running; await server.drain();
  const done = await convFor(callId);
  assert.ok(done.ended_at);
  assert.deepEqual([done.turn_count, done.final_status, done.ended_reason], [1, 'clarified', 'customer-ended-call']);
  assert.equal(sessions.has(done.id), false);
  await dropConversation(done.id);
});

test('end-of-call-report delivered twice finalises once', { skip: skipWithoutDatabase }, async () => {
  const callId = `call-${randomUUID()}`;
  await (await completion(callId, 'hello')).text();
  await event({ type: 'end-of-call-report', endedReason: 'customer-ended-call', call: { id: callId } }); await server.drain();
  const first = await convFor(callId);
  await event({ type: 'end-of-call-report', endedReason: 'silence-timed-out', call: { id: callId } }); await server.drain();
  const second = await convFor(callId);
  assert.deepEqual([second.ended_at.getTime(), second.ended_reason], [first.ended_at.getTime(), 'customer-ended-call']);
  await dropConversation(first.id);
});

test('status-update in-progress opens the session before the caller speaks, once however often it arrives', { skip: skipWithoutDatabase }, async () => {
  const callId = `call-${randomUUID()}`;
  const before = rec.opened.length;
  for (let i = 0; i < 2; i++) await event({ type: 'status-update', status: 'in-progress', call: { id: callId, type: 'inboundPhoneCall', customer: { number: '+15551234567' } } });
  await server.drain();
  const c = await convFor(callId);
  assert.deepEqual([c.channel, c.caller_identifier, rec.opened.length - before, sessions.has(c.id)], ['voice_phone', '***4567', 1, true]);
  await sessions.close(c.id); await dropConversation(c.id);
});

test('Review Focus 5: /chat refuses a message over 1,000 characters with 400 and writes nothing', { skip: skipWithoutDatabase }, async () => {
  const [{ n: before }] = await query(`select count(*)::int n from public.conversations`);
  const res = await chat({ channel: 'web_text', message: 'x'.repeat(20_000) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /1,000/);
  const [{ n: afterCount }] = await query(`select count(*)::int n from public.conversations`);
  assert.equal(afterCount, before);
  assert.equal((await chat({ channel: 'web_text', message: '   ' })).status, 400);
  assert.equal((await chat({ channel: 'voice_web', message: 'hi' })).status, 400);
});

test('/chat ignores a model override outside eval, and a model not on the allowlist', { skip: skipWithoutDatabase }, async () => {
  const ids: string[] = [];
  for (const body of [{ channel: 'web_text', model: 'claude-sonnet-5' }, { channel: 'eval', model: 'claude-opus-5' }, { channel: 'eval', model: 'claude-sonnet-5' }]) {
    const r = await (await chat({ ...body, message: 'hello there' })).json();
    ids.push(r.conversation_id);
  }
  const models = ids.map((id) => rec.opened.find((o) => o.id === id)?.opts.model);
  assert.deepEqual(models, [undefined, undefined, 'claude-sonnet-5']);
  for (const id of ids) { await sessions.close(id); await dropConversation(id); }
});

test('row 22: with fault mcp_down, the failure line is returned, the turn is failed, and nothing is invented',
  { skip: skipWithoutDatabase || !process.env.ANTHROPIC_API_KEY, timeout: 120_000 }, async () => {
  process.env.ALLOW_FAULT_INJECTION = 'true';
  const { claudeRuntime } = await import('../../agent/claude-runtime.ts');
  const real = new SessionManager(claudeRuntime(), { max: 1 });
  const s3 = createAgentServer({ sessions: real }); await new Promise<void>((r) => s3.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${(s3.address() as any).port}/chat`, { method: 'POST',
    headers: { authorization: 'Bearer internal-test', 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'eval', fault: 'mcp_down', message: 'Can you check transaction TXN-9001?' }) });
  const r = await res.json();
  try {
    const [t] = await query('select status, assistant_response from public.conversation_turns where conversation_id = $1', [r.conversation_id]);
    assert.deepEqual([r.status, t.status, r.reply], ['failed', 'failed', LINES.failure]);
  } finally {
    process.env.ALLOW_FAULT_INJECTION = 'false';
    await real.closeAll(); s3.close(); await dropConversation(r.conversation_id);
  }
});
