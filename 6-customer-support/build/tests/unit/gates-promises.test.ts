import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPromises } from '../../lib/gates/promises.ts';

test('guarantees and dated promises are caught', () => {
  for (const s of ['We guarantee it arrives by 9am tomorrow.', 'It will definitely land today.',
                   'Your payout will be processed within 2 days.', 'It will arrive by Friday.', 'The review will be resolved by Monday.'])
    assert.ok(findPromises(s).length > 0, s);
});

test('negated forms pass, because declining to promise is the point', () => {
  for (const s of ["We can't guarantee it arrives by 9am tomorrow.", 'RelayPay cannot guarantee payment timelines.',
                   "I'm not able to promise a time."])
    assert.deepEqual(findPromises(s), [], s);
});

test('a negation in a different clause does not excuse a promise', () => {
  assert.ok(findPromises("I can't check that, but it will definitely arrive by 9am.").length > 0);
});

test('policy phrasing and a confirmed callback are not promises', () => {
  for (const s of ['International payouts usually take 2 to 5 business days.', 'A specialist will call you on Tuesday at 14:00 UTC.'])
    assert.deepEqual(findPromises(s), [], s);
});
