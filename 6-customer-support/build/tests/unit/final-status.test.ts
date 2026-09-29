import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFinalStatus, buildSummary } from '../../lib/conversations.ts';

test('escalation outranks ticket, which outranks answers', () => {
  assert.equal(deriveFinalStatus({ userTurns: 3, answerTypes: ['answer', 'escalate'], failedTurns: 0, hasTicket: true, hasEscalation: true }), 'escalated');
  assert.equal(deriveFinalStatus({ userTurns: 2, answerTypes: ['clarify', 'answer'], failedTurns: 0, hasTicket: true, hasEscalation: false }), 'ticketed');
});
test('no caller turn is abandoned; only failures is failed; last decline is declined; all clarify is clarified', () => {
  assert.equal(deriveFinalStatus({ userTurns: 0, answerTypes: [], failedTurns: 0, hasTicket: false, hasEscalation: false }), 'abandoned');
  assert.equal(deriveFinalStatus({ userTurns: 1, answerTypes: ['decline'], failedTurns: 1, hasTicket: false, hasEscalation: false }), 'failed');
  assert.equal(deriveFinalStatus({ userTurns: 2, answerTypes: ['answer', 'decline'], failedTurns: 0, hasTicket: false, hasEscalation: false }), 'declined');
  assert.equal(deriveFinalStatus({ userTurns: 1, answerTypes: ['clarify'], failedTurns: 0, hasTicket: false, hasEscalation: false }), 'clarified');
  assert.equal(deriveFinalStatus({ userTurns: 1, answerTypes: ['answer'], failedTurns: 0, hasTicket: false, hasEscalation: false }), 'resolved');
});
test('the summary is built from records, names references, and contains no dash', () => {
  const s = buildSummary({ turns: 3, answerTypes: ['answer', 'escalate', 'escalate'], ticketRef: 'RP-T-000012',
    escalation: { ref: 'RP-E-000004', category: 'account', booked: true, slot: 'Tuesday 6 October at 14:00 UTC' } });
  assert.equal(s, '3 turns. 1 answered. Ticket RP-T-000012. Escalation RP-E-000004 (account), callback booked for Tuesday 6 October at 14:00 UTC.');
});

test('a summary with nothing answered, ticketed or escalated says so plainly, in the singular', () => {
  assert.equal(buildSummary({ turns: 1, answerTypes: ['clarify'], ticketRef: null, escalation: null }), '1 turn. None answered.');
});

test('an escalation without a booking says the callback was not booked', () => {
  assert.equal(buildSummary({ turns: 2, answerTypes: ['escalate', 'escalate'], ticketRef: null,
    escalation: { ref: 'RP-E-000009', category: 'dispute', booked: false, slot: null } }),
    '2 turns. None answered. Escalation RP-E-000009 (dispute), callback not booked.');
});
