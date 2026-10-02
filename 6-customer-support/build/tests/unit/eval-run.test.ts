import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../evals/run.ts';
import { SCENARIOS } from '../../evals/scenarios.ts';

const fakePost = () => {
  const calls: { path: string; body: any }[] = [];
  const post = async (path: string, body: any) => { calls.push({ path, body });
    return { status: 200, json: path === '/chat' ? { conversation_id: 'conv-1', reply: 'same reply' } : {} }; };
  return { calls, post };
};

test('row 24: the re-post carries the conversation the first post created, as a Vapi reconnect does', async () => {
  const f = fakePost();
  const s = SCENARIOS.find((x) => x.row === 24)!;
  const r = await runScenario(s, 'run-1', 'claude-haiku-4-5', f.post);
  const chats = f.calls.filter((c) => c.path === '/chat');
  assert.equal(chats.length, 2);
  assert.equal(chats[0].body.conversation_id, undefined);
  assert.equal(chats[1].body.conversation_id, 'conv-1');
  assert.equal(chats[1].body.message, chats[0].body.message);
  assert.deepEqual([r.conversationId, r.error], ['conv-1', undefined]);
});

test('every later turn continues the same conversation, and the run ends it', async () => {
  const f = fakePost();
  await runScenario(SCENARIOS.find((x) => x.row === 7)!, 'run-1', 'claude-haiku-4-5', f.post);
  const chats = f.calls.filter((c) => c.path === '/chat');
  assert.deepEqual(chats.map((c) => c.body.conversation_id), [undefined, 'conv-1', 'conv-1']);
  assert.deepEqual(f.calls.at(-1), { path: '/chat/end', body: { conversation_id: 'conv-1', reason: 'eval_end' } });
});

test('row 14 verifies Amara before asking about the AccraStack transaction', () => {
  const s = SCENARIOS.find((x) => x.row === 14)!;
  assert.match(s.turns[0], /check my account/i);
});

test('a request that throws, such as a timeout during a network drop, fails that scenario with the reason, not the whole run', async () => {
  const post = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const r = await runScenario(SCENARIOS.find((x) => x.row === 1)!, 'run-1', 'claude-haiku-4-5', post as any);
  assert.equal(r.conversationId, null);
  assert.match(r.error!, /turn 1: .*timeout/i);
});
