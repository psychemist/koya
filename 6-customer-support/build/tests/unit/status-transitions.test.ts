import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../../lib/console.ts';

test('closed is terminal; nothing skips backwards', () => {
  assert.equal(canTransition('open', 'in_progress'), true);
  assert.equal(canTransition('in_progress', 'closed'), true);
  assert.equal(canTransition('open', 'closed'), true);
  assert.equal(canTransition('closed', 'open'), false);
  assert.equal(canTransition('in_progress', 'open'), false);
});

test('a move to the same status, or to a status that does not exist, is not a transition', () => {
  assert.equal(canTransition('open', 'open'), false);
  assert.equal(canTransition('open', 'resolved' as any), false);
});
