import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import { startMcpHttp } from '../../mcp/http.ts';
import { connectTestClient } from '../fakes/mcp-client.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

// Assigned, not defaulted: .env.local carries the real token, and these tests send this one.
process.env.MCP_TOKEN = 'test-token';
process.env.MCP_ALLOWED_ORIGINS = '';
const echo = { name: 'echo_conversation', description: 'test', input: z.object({}), readOnly: true,
  run: async (_a: object, conversationId: string) => ({ result: { conversationId }, summary: {} }) };
let server: any, url = '';
before(async () => { server = await startMcpHttp(0, [echo as any]); url = `http://127.0.0.1:${server.address().port}/mcp`; });
after(() => server.close());

test('no bearer token is a 401 before any tool runs', async () => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('a wrong token is a 401, compared in constant time', async () => {
  const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('a browser Origin not on the allowlist is a 403', async () => {
  const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-token', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('a tool sees the conversation from the header, over real Streamable HTTP', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const client = await connectTestClient(url, { authorization: 'Bearer test-token', 'x-conversation-id': c.id });
  assert.deepEqual(await client.listTools(), ['echo_conversation']);
  const r = await client.call('echo_conversation', { purpose: 'test' });
  assert.equal(r.json.conversationId, c.id);
  await client.close(); await dropConversation(c.id);
});

test('GET /health answers without a token and says nothing secret', async () => {
  const res = await fetch(url.replace('/mcp', '/health'));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), ['db', 'ok', 'tools']);
});
