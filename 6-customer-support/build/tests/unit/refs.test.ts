import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRef } from '../../lib/refs.ts';

test('the forms a caller or a transcriber produces all land on one reference', () => {
  for (const raw of ['TXN-9001', 'txn 9001', 'TXN9001', 't x n nine zero zero one', 'T X N 9 0 0 1',
                     'transaction nine oh oh one', 'txn-9001.'])
    assert.equal(normalizeRef(raw, 'TXN'), 'TXN-9001', raw);
});

test('four bare digits are accepted when the kind is known from the tool', () => {
  assert.equal(normalizeRef('7002', 'PAY'), 'PAY-7002');
});

test('five digits, three digits or the wrong prefix are not a reference', () => {
  assert.equal(normalizeRef('TXN-90011', 'TXN'), null);
  assert.equal(normalizeRef('TXN-900', 'TXN'), null);
  assert.equal(normalizeRef('PAY-7002', 'TXN'), null);
});
