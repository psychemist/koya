import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../../lib/rate-limit.ts';

test('the 21st message in ten minutes is refused, and the window slides', () => {
  const l = createLimiter({ perWindow: 20, windowMs: 600_000 });
  for (let i = 0; i < 20; i++) assert.equal(l.take('1.2.3.4', 0), true);
  assert.equal(l.take('1.2.3.4', 1), false);
  assert.equal(l.take('5.6.7.8', 1), true);
  assert.equal(l.take('1.2.3.4', 600_001), true);
});
