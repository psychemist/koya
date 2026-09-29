import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoise, frameCallerText } from '../../agent/turn.ts';

test('Review Focus 3: fillers and empty transcripts are noise; a real one-word answer is not', () => {
  for (const s of ['', ' ', 'uh', 'Um.', 'hmm', 'mm-hmm', 'ah']) assert.equal(isNoise(s), true, JSON.stringify(s));
  for (const s of ['yes', 'no', 'Efua', 'TXN-9001']) assert.equal(isNoise(s), false, s);
});

test('each turn carries the current time, and prior transcript is labelled as context only', () => {
  const t = frameCallerText('hello', new Date('2026-10-05T09:00:00Z'), 'Caller: my payout\nAgent: which one?');
  assert.match(t, /^\[Current time: 2026-10-05T09:00:00.000Z UTC\]/);
  assert.match(t, /\[Prior transcript, for context only\]/);
  assert.match(t, /Caller said: hello$/);
});
