import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

Object.assign(process.env, { SESSION_SECRET: 's'.repeat(32), APP_BASE_URL: 'http://localhost:3000', EMBEDDINGS: 'fixture' });
const { query, one } = await import('../../lib/db.ts');
const { issue, hashPassword } = await import('../../lib/auth.ts');
const { conversationDetail } = await import('../../lib/console.ts');
const escRoute = await import('../../app/api/escalations/[id]/status/route.ts');
const ticketRoute = await import('../../app/api/tickets/[id]/status/route.ts');
const evalRoute = await import('../../app/api/evaluations/route.ts');
const { escalationTool } = await import('../../mcp/tools/create-escalation.ts');
const { ticketTool } = await import('../../mcp/tools/create-support-ticket.ts');
const { searchTool } = await import('../../mcp/tools/search-knowledge-base.ts');
const { withToolCall } = await import('../../mcp/toolcall.ts');
const { withRequestContext } = await import('../../mcp/context.ts');
const { runTurn } = await import('../../agent/turn.ts');
const { SessionManager } = await import('../../agent/sessions.ts');
const { fakeRuntime } = await import('../fakes/runtime.ts');
const { skipWithoutDatabase, newConversation, dropConversation } = await import('../helpers.ts');

let userId = '';
before(async () => {
  if (skipWithoutDatabase) return;
  const email = `console-test-${randomUUID()}@example.com`;
  userId = (await one<{ id: string }>(`insert into public.users (email, name, role, password_hash) values ($1, 'Test Agent', 'support_agent', $2) returning id`,
    [email, hashPassword('not-used')]))!.id;
});

const req = (url: string, body: unknown, signedIn = true) => new Request(`http://localhost:3000${url}`, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(signedIn ? { cookie: `rp_console_session=${issue(userId)}` } : {}) }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const escalate = (conv: string) => withRequestContext({ conversationId: conv, fault: null }, async () =>
  (await escalationTool.run({ user_name: 'Efua Mensah', user_email: 'efua@accrastack.example', category: 'account',
    reason: 'Restricted account, caller needs a specialist.' } as any, conv)).result as any);

test('every console API route is 401 without a session', async () => {
  const id = randomUUID();
  assert.equal((await escRoute.POST(req(`/api/escalations/${id}/status`, { from: 'open', to: 'closed' }, false), params(id))).status, 401);
  assert.equal((await ticketRoute.POST(req(`/api/tickets/${id}/status`, { from: 'open', to: 'closed' }, false), params(id))).status, 401);
  assert.equal((await evalRoute.POST(req('/api/evaluations', { scenario_key: 'x' }, false))).status, 401);
  const forged = new Request('http://localhost:3000/api/evaluations', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'rp_console_session=u.9999999999.bad' }, body: '{}' });
  assert.equal((await evalRoute.POST(forged)).status, 401);
});

test('a status change from another site is refused even with a session', { skip: skipWithoutDatabase }, async () => {
  const id = randomUUID();
  const r = new Request(`http://localhost:3000/api/escalations/${id}/status`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: `rp_console_session=${issue(userId)}` },
    body: JSON.stringify({ from: 'open', to: 'closed' }) });
  assert.equal((await escRoute.POST(r, params(id))).status, 403);
});

test('closing an escalation twice is one transition; the second answers 409 with the current status', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await escalate(c.id);
  const e = (await one<{ id: string }>('select id from public.escalations where conversation_id = $1', [c.id]))!;
  const first = await escRoute.POST(req(`/api/escalations/${e.id}/status`, { from: 'open', to: 'closed' }), params(e.id));
  assert.equal(first.status, 200);
  const second = await escRoute.POST(req(`/api/escalations/${e.id}/status`, { from: 'open', to: 'closed' }), params(e.id));
  assert.equal(second.status, 409);
  assert.equal((await second.json()).status, 'closed');
  const bad = await escRoute.POST(req(`/api/escalations/${e.id}/status`, { from: 'closed', to: 'open' }), params(e.id));
  assert.equal(bad.status, 422);
  await dropConversation(c.id);
});

test('closing an escalation frees the conversation to open a new one later', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const a = await escalate(c.id);
  const e = (await one<{ id: string }>('select id from public.escalations where conversation_id = $1', [c.id]))!;
  assert.equal((await escRoute.POST(req(`/api/escalations/${e.id}/status`, { from: 'open', to: 'closed' }), params(e.id))).status, 200);
  const b = await escalate(c.id);
  assert.notEqual(a.escalation_id, b.escalation_id);
  const [{ n }] = await query(`select count(*)::int n from public.escalations where conversation_id = $1`, [c.id]);
  assert.equal(n, 2);
  await dropConversation(c.id);
});

test('a ticket moves open to in progress to closed, and each step is recorded once', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const t = (await ticketTool.run({ category: 'invoice', priority: 'normal', summary: 'Invoice payment failed; customer wants it checked.' } as any, c.id)).result as any;
  const row = (await one<{ id: string }>('select id from public.support_tickets where ticket_ref = $1', [t.ticket_id]))!;
  assert.equal((await ticketRoute.POST(req(`/api/tickets/${row.id}/status`, { from: 'open', to: 'in_progress' }), params(row.id))).status, 200);
  assert.equal((await ticketRoute.POST(req(`/api/tickets/${row.id}/status`, { from: 'in_progress', to: 'closed' }), params(row.id))).status, 200);
  const [s] = await query('select status from public.support_tickets where id = $1', [row.id]);
  assert.equal(s.status, 'closed');
  await dropConversation(c.id);
});

test('a manual evaluation is stored with source manual and the signed-in user as created_by', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const res = await evalRoute.POST(req('/api/evaluations', { scenario_key: 'brief-9-voice', scenario_title: 'Voice flow',
    expected: 'Spoken question, spoken reply, records logged with channel voice_web.', actual: 'Asked the fees question by voice and heard a grounded reply.',
    passed: true, notes: 'Recorded from the demo call.', conversation_id: c.id }));
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const [row] = await query('select source, created_by, passed, conversation_id from public.evaluations where id = $1', [id]);
  assert.deepEqual(row, { source: 'manual', created_by: userId, passed: true, conversation_id: c.id });
  assert.equal((await evalRoute.POST(req('/api/evaluations', { scenario_key: '', expected: 'x', actual: 'y', passed: true }))).status, 400);
  await query('delete from public.evaluations where id = $1', [id]);
  await dropConversation(c.id);
});

test('conversationDetail returns every table the PRD lists for one conversation', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'eval' });
  const rt = fakeRuntime([async () => {
    await withToolCall(c.id, 'search_knowledge_base', 'test', { query: 'fees' }, () => searchTool.run({ query: 'how does relaypay charge fees' }, c.id));
    return [{ kind: 'result', ok: true, costUsd: 0.001, durationMs: 5, output: { answer_type: 'escalate',
      spoken_response: 'This needs a specialist. Could I take your name and email?', citations: [], confidence_note: 'test', escalation_category: 'account' } }];
  }]);
  await runTurn({ sessions: new SessionManager(rt) }, { conversationId: c.id, text: 'My account was restricted.' }, { say() {} });
  await ticketTool.run({ category: 'account', priority: 'high', summary: 'Restricted account needs a specialist.' } as any, c.id);
  await escalate(c.id);
  const d = await conversationDetail(c.id);
  assert.ok(d);
  for (const k of ['turns', 'retrievals', 'toolCalls', 'tickets'] as const) assert.ok(d![k].length > 0, `${k} is empty`);
  assert.ok(d!.escalation, 'escalation missing');
  assert.ok(d!.events.length > 0, 'events missing');
  assert.equal(d!.conversation.id, c.id);
  await dropConversation(c.id);
});

test('cleanup: the test user is removed', { skip: skipWithoutDatabase }, async () => {
  await query('delete from public.users where id = $1', [userId]);
});
