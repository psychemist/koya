import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSse } from '../../agent/sse.ts';

test('each say() is one chat.completion.chunk frame, and finish() ends with a stop frame and [DONE]', () => {
  const chunks: string[] = []; const res: any = { writeHead() {}, write: (s: string) => chunks.push(s), end() {}, writableEnded: false };
  const s = openSse(res); s.say('One moment.'); s.say('Fees vary.'); s.finish();
  const frames = chunks.join('').trim().split('\n\n');
  assert.equal(JSON.parse(frames[0].slice(6)).choices[0].delta.content, 'One moment. ');
  assert.equal(JSON.parse(frames[2].slice(6)).choices[0].finish_reason, 'stop');
  assert.equal(frames[3], 'data: [DONE]');
});
test('writes after the client has gone are dropped, not thrown', () => {
  const res: any = { writeHead() {}, write() { throw new Error('closed'); }, end() {}, writableEnded: true };
  assert.doesNotThrow(() => { const s = openSse(res); s.say('x'); s.finish(); });
});
