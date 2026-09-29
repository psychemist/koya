// Calls the route handlers directly with a Request. A local stub stands in for the agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from '../fakes/http-stub.ts';

Object.assign(process.env, { APP_BASE_URL: 'http://localhost:3000', SESSION_SECRET: 's'.repeat(32), AGENT_INTERNAL_TOKEN: 'internal-test' });
const { POST, DELETE } = await import('../../app/api/chat/route.ts');
const { issueChatToken, readChatToken } = await import('../../lib/chat-session.ts');

let agent: Awaited<ReturnType<typeof startStub>>;
let reply: (body: any) => { status: number; json: any } = () => ({ status: 500, json: {} });
before(async () => { agent = await startStub(async (body) => reply(body)); process.env.AGENT_URL = agent.url.replace(/\/$/, ''); });
after(() => agent.close());

let ip = 0;
const req = (method: string, body?: unknown, h: Record<string, string> = {}) => new Request('http://localhost:3000/api/chat', {
  method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++ip}`, ...h },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const cookieOf = (r: Response) => r.headers.get('set-cookie')?.match(/rp_chat=([^;]*)/)?.[1] ?? null;
const conv = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ok = (id = conv) => ({ status: 200, json: { conversation_id: id, reply: 'Is it incoming, outgoing, or an invoice payment?',
  answer_type: 'clarify', status: 'ok', ended: false, records: { ticket_ref: null, escalation_ref: null, call_booked: false, appointment: null } } });

test('Review Focus 5: a 20,000 character paste is refused with 400 and the agent is never called', async () => {
  const before = agent.calls.length;
  const r = await POST(req('POST', { message: 'x'.repeat(20_000) }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /under 1,000 characters/);
  assert.equal(agent.calls.length, before);
});

test('a cross-origin POST is 403 and a form-encoded body is 415, before the agent is called', async () => {
  const before = agent.calls.length;
  assert.equal((await POST(req('POST', { message: 'hi' }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await POST(req('POST', 'message=hi', { 'content-type': 'application/x-www-form-urlencoded' }))).status, 415);
  assert.equal(agent.calls.length, before);
});

test('the first message sets an httpOnly chat cookie, and neither the conversation id nor the token reaches the browser', async () => {
  reply = () => ok();
  const r = await POST(req('POST', { message: 'my payment is stuck' }));
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes(conv) && !text.includes('internal-test'));
  assert.match(r.headers.get('set-cookie')!, /HttpOnly/);
  assert.equal(readChatToken(cookieOf(r)), conv);
  const call = agent.calls.at(-1)!;
  assert.deepEqual([call.path, call.headers.authorization, call.body.channel, call.body.conversation_id],
    ['/chat', 'Bearer internal-test', 'web_text', undefined]);
});

test('the next message continues the cookie conversation, and a conversation_id in the body is ignored', async () => {
  reply = () => ok();
  await POST(req('POST', { message: 'it is outgoing', conversation_id: other }, { cookie: `rp_chat=${issueChatToken(conv)}` }));
  assert.equal(agent.calls.at(-1)!.body.conversation_id, conv);
});

test('row 26: a forged cookie starts a new chat instead of continuing another one', async () => {
  reply = () => ok(other);
  const t = issueChatToken(conv);
  const forged = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  await POST(req('POST', { message: 'hello' }, { cookie: `rp_chat=${forged}` }));
  assert.equal(agent.calls.at(-1)!.body.conversation_id, undefined);
});

test('row 27: when the agent says the chat ended, the route starts a new one and rotates the cookie', async () => {
  const seen: (string | undefined)[] = [];
  reply = (b) => { seen.push(b.conversation_id); return b.conversation_id ? { status: 409, json: { error: 'conversation_ended' } } : ok(other); };
  const r = await POST(req('POST', { message: 'hello again' }, { cookie: `rp_chat=${issueChatToken(conv)}` }));
  assert.deepEqual([seen, (await r.json()).new_chat], [[conv, undefined], true]);
  assert.equal(readChatToken(cookieOf(r)), other);
});

test('the 21st message from one address in ten minutes is 429', async () => {
  reply = () => ok();
  const h = { 'x-forwarded-for': '10.9.9.9' };
  for (let i = 0; i < 20; i++) assert.equal((await POST(req('POST', { message: `m${i}` }, h))).status, 200);
  assert.equal((await POST(req('POST', { message: 'one more' }, h))).status, 429);
});

test('an agent outage is a 503 with a plain sentence, not a stack trace', async () => {
  reply = () => ({ status: 502, json: { error: 'boom' } });
  const r = await POST(req('POST', { message: 'hello' }));
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /^Chat is unavailable right now\./);
});

test('end chat tells the agent once and clears the cookie', async () => {
  reply = () => ({ status: 200, json: {} });
  const before = agent.calls.length;
  const r = await DELETE(req('DELETE', undefined, { cookie: `rp_chat=${issueChatToken(conv)}` }));
  assert.equal(r.status, 204);
  assert.equal(agent.calls.length - before, 1);
  assert.deepEqual([agent.calls.at(-1)!.path, agent.calls.at(-1)!.body.conversation_id], ['/chat/end', conv]);
  assert.match(r.headers.get('set-cookie')!, /rp_chat=;.*Max-Age=0/);
});
