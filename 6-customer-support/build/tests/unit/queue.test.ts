import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQueue } from '../../agent/queue.ts';

test('a value pushed before anyone waits is buffered, in order', async () => {
  const q = new AsyncQueue<number>(); q.push(1); q.push(2);
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual([(await it.next()).value, (await it.next()).value], [1, 2]);
});

test('a waiting reader is woken by the next push', async () => {
  const q = new AsyncQueue<string>(); const it = q[Symbol.asyncIterator]();
  const p = it.next(); q.push('hello');
  assert.deepEqual(await p, { value: 'hello', done: false });
});

test('end() finishes waiting readers and later reads, after the buffer drains', async () => {
  const q = new AsyncQueue<number>(); const it = q[Symbol.asyncIterator]();
  q.push(7); q.end();
  assert.deepEqual(await it.next(), { value: 7, done: false });
  assert.equal((await it.next()).done, true);
  const q2 = new AsyncQueue<number>(); const w = q2[Symbol.asyncIterator]().next(); q2.end();
  assert.equal((await w).done, true);
});
