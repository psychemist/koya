import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from '../fakes/http-stub.ts';

let agent: Awaited<ReturnType<typeof startStub>>;
let health: () => { status: number; json: any };
before(async () => { agent = await startStub(async () => health()); process.env.AGENT_URL = agent.url.replace(/\/$/, ''); });
after(() => agent.close());
const { GET } = await import('../../app/api/voice/availability/route.ts');

test('a healthy agent with free capacity is available', async () => {
  health = () => ({ status: 200, json: { ok: true, db: true, mcp: true, sessions: 1, capacity: 2 } });
  assert.deepEqual(await (await GET()).json(), { available: true });
});

test('a full agent is busy, and a failing one is down', async () => {
  health = () => ({ status: 200, json: { ok: true, db: true, mcp: true, sessions: 3, capacity: 0 } });
  assert.deepEqual(await (await GET()).json(), { available: false, reason: 'busy' });
  health = () => ({ status: 503, json: { ok: false } });
  assert.deepEqual(await (await GET()).json(), { available: false, reason: 'down' });
});

test('an unreachable agent is down, and the answer names no URL', async () => {
  process.env.AGENT_URL = 'http://127.0.0.1:9';
  const text = await (await GET()).text();
  assert.deepEqual(JSON.parse(text), { available: false, reason: 'down' });
  assert.ok(!text.includes('127.0.0.1'));
  process.env.AGENT_URL = agent.url.replace(/\/$/, '');
});
