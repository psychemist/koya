import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../lib/csv.ts';

test('an empty trailing field is an empty string, not a missing key', () => {
  const [r] = parseCsv('a,b,c\n1,,\n');
  assert.deepEqual(r, { a: '1', b: '', c: '' });
});

test('quoted fields keep their commas, and CRLF is tolerated', () => {
  const [r] = parseCsv('id,note\r\n1,"late, then paid"\r\n');
  assert.equal(r.note, 'late, then paid');
});

test('a row with the wrong number of fields is an error naming the line', () => {
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), /line 2/);
});
