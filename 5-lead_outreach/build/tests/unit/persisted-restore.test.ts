import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restored } from '../../app/ui/use-persisted.ts';

/**
 * What comes back out of storage is last week's shape, not this week's.
 *
 * The intake form kept every field in one stored object. A browser holding a
 * copy written before `target_leads` existed restored an object without it,
 * the input's value went from '10' to undefined, and React reported a
 * controlled input turning uncontrolled the moment somebody typed in it.
 */
const EMPTY = { objective: '', geography: '', headcount: '', target_leads: '10' };

test('a field the stored copy never had keeps its initial value', () => {
  const out = restored(EMPTY, { objective: 'US B2B SaaS', geography: '', headcount: '' });
  assert.equal(out.target_leads, '10');
  assert.equal(out.objective, 'US B2B SaaS');
});

test('a stored copy that has every field wins outright', () => {
  const stored = { objective: 'a', geography: 'b', headcount: 'c', target_leads: '25' };
  assert.deepEqual(restored(EMPTY, stored), stored);
});

test('a field the form no longer has is dropped rather than carried', () => {
  const out = restored(EMPTY, { ...EMPTY, industry: 'logistics' });
  assert.deepEqual(Object.keys(out).sort(), Object.keys(EMPTY).sort());
});

test('a field stored as the wrong type keeps its initial value', () => {
  // The number input posts strings. A stored 10 would make the field a number
  // and the first keystroke would change its type under React.
  assert.equal(restored(EMPTY, { ...EMPTY, target_leads: 10 }).target_leads, '10');
  assert.equal(restored(EMPTY, { ...EMPTY, objective: null }).objective, '');
  assert.equal(restored(EMPTY, { ...EMPTY, geography: undefined }).geography, '');
});

test('a stored value of the wrong shape is ignored entirely', () => {
  assert.deepEqual(restored(EMPTY, null), EMPTY);
  assert.deepEqual(restored(EMPTY, 'a string'), EMPTY);
  assert.deepEqual(restored(EMPTY, ['an array']), EMPTY);
});

test('a plain value round trips without being treated as a shape', () => {
  assert.equal(restored('qualified', 'not_qualified'), 'not_qualified');
  assert.equal(restored('qualified', 42), 'qualified');
});
