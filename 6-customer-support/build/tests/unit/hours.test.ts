import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlot, nextSlots, describeSlot } from '../../lib/hours.ts';

const now = new Date('2026-10-05T09:00:00Z'); // Monday

test('a Tuesday 14:00 UTC slot is valid', () => {
  assert.equal(validateSlot('2026-10-06T14:00:00Z', now).ok, true);
});

test('Review Focus 2: a time with no offset is refused, never guessed', () => {
  const r = validateSlot('2026-10-06T14:00:00', now);
  assert.deepEqual([r.ok, (r as any).code], [false, 'TIME_NEEDS_OFFSET']);
});

test('an offset is honoured: 15:00 in Lagos (+01:00) is 14:00 UTC', () => {
  const r = validateSlot('2026-10-06T15:00:00+01:00', now) as any;
  assert.equal(r.start.toISOString(), '2026-10-06T14:00:00.000Z');
});

test('row 21: Sunday 03:00 is outside hours and comes back with three valid suggestions', () => {
  const r = validateSlot('2026-10-11T03:00:00Z', now) as any;
  assert.equal(r.code, 'OUTSIDE_HOURS');
  assert.equal(r.suggestions.length, 3);
  for (const s of r.suggestions) assert.equal(validateSlot(s.toISOString(), now).ok, true);
});

test('a slot that would run past 18:00 is outside hours', () => {
  assert.equal((validateSlot('2026-10-06T17:45:00Z', now) as any).code, 'OUTSIDE_HOURS');
});

test('less than 15 minutes ahead counts as the past', () => {
  assert.equal((validateSlot('2026-10-05T09:10:00Z', now) as any).code, 'TIME_IN_PAST');
});

test('a Friday 17:40 request rolls the next slots to Monday morning', () => {
  const s = nextSlots(new Date('2026-10-09T17:40:00Z'), 2);
  assert.deepEqual(s.map((d) => d.toISOString()), ['2026-10-12T08:00:00.000Z', '2026-10-12T08:30:00.000Z']);
});

test('a slot is described in UTC, and in the caller timezone when known', () => {
  const d = new Date('2026-10-06T14:00:00Z');
  assert.equal(describeSlot(d), 'Tuesday 6 October at 14:00 UTC');
  assert.equal(describeSlot(d, 'Africa/Lagos'), 'Tuesday 6 October at 14:00 UTC, which is 15:00 in Lagos');
  assert.equal(describeSlot(d, 'Not/AZone'), 'Tuesday 6 October at 14:00 UTC');
});
