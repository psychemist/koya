import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, fallbackFor } from '../../lib/lines.ts';

test('no fixed line contains an em dash or en dash', () => {
  for (const [k, v] of Object.entries(LINES)) assert.ok(!/[—–]/.test(v), `${k} contains a dash`);
});

test('the goodbye line is the exact Vapi end-call phrase', () => {
  assert.equal(LINES.goodbye, 'Thanks for calling RelayPay support, goodbye.');
});

test('the fallback for an intended escalation is the escalate line, and everything else declines', () => {
  assert.equal(fallbackFor('escalate'), LINES.escalate);
  for (const t of ['answer', 'clarify', 'decline', undefined] as const) assert.equal(fallbackFor(t), LINES.decline);
});
