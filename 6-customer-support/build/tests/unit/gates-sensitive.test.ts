import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSensitive } from '../../lib/gates/sensitive.ts';

const f = (p = {}) => ({ groundedChunkIds: new Set<string>(), escalationRequired: false, callerText: '', knownEmails: [],
  verifiedCustomerId: null, supportNotes: ['Account is under compliance review. Escalate account-specific questions.'], ...p });

test('row 15: repeating six words of an internal note is caught', () => {
  assert.ok(findSensitive('The account is under compliance review, escalate account-specific questions.', f()).length > 0);
});

test('an email the caller never gave is caught; one they gave is allowed', () => {
  assert.ok(findSensitive('I have amara@lagosledger.example on file.', f()).length > 0);
  assert.deepEqual(findSensitive('I will send it to amara@lagosledger.example.', f({ knownEmails: ['amara@lagosledger.example'] })), []);
});

test('an amount is caught unless the caller said it or the owner is verified', () => {
  assert.ok(findSensitive('That payout is 5,300 GBP.', f()).length > 0);
  assert.deepEqual(findSensitive('That payout is 2400 USD.', f({ callerText: 'my 2400 usd payout' })), []);
  assert.deepEqual(findSensitive('That payout is $2,400.', f({ verifiedCustomerId: 'CUS-1001' })), []);
});

test('internal vocabulary is caught', () => {
  for (const s of ['Your risk score is high.', 'It was flagged by our system.', 'Your KYC status is review required.'])
    assert.ok(findSensitive(s, f({ supportNotes: [] })).length > 0, s);
});
