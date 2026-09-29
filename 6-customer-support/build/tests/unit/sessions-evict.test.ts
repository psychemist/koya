import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../agent/sessions.ts';
import { queueRuntime } from '../fakes/runtime.ts';

test('evictOneIdle closes the least recently used idle chat session and never a voice one', async () => {
  const m = new SessionManager(queueRuntime().runtime, { max: 3 });
  await m.getOrOpen('v1', { kind: 'voice' });
  await m.getOrOpen('c1', { kind: 'chat' });
  await m.getOrOpen('c2', { kind: 'chat' });
  assert.equal(await m.evictOneIdle('chat'), true);
  assert.deepEqual(['v1', 'c1', 'c2'].map((id) => m.has(id)), [true, false, true]);
});

test('a chat session with a turn in flight is not evicted', async () => {
  const q = queueRuntime();
  let release!: () => void;
  q.next(() => new Promise((r) => { release = () => r([]); }));
  const m = new SessionManager(q.runtime, { max: 1 });
  const s = await m.getOrOpen('c1', { kind: 'chat' });
  const running = m.withLock('c1', async () => { for await (const _ of s.turn('x')) { /* drain */ } });
  await new Promise((r) => setImmediate(r));
  assert.equal(await m.evictOneIdle('chat'), false);
  release(); await running;
});

test('closeIdle by kind leaves the other kind open', async () => {
  const m = new SessionManager(queueRuntime().runtime, { max: 3 });
  await m.getOrOpen('v1', { kind: 'voice' });
  await m.getOrOpen('c1', { kind: 'chat' });
  assert.equal(await m.closeIdle(0, 'chat'), 1);
  assert.deepEqual([m.has('v1'), m.has('c1')], [true, false]);
});
