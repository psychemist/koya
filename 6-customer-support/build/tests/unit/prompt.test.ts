import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../../agent/prompt.ts';

// Each rule below was added after an eval failure on 2026-10-02 (run a52e466f). The prompt is the
// agent's judgment; these tests stop a later edit from quietly dropping a rule the evals depend on.
test('row 3: two identifiers and an account question means look the account up first', () => {
  assert.match(SYSTEM_PROMPT, /two identifiers[^.]*call lookup_customer before/i);
});
test('row 17: a refund, dispute or cancellation escalates on the first turn, without waiting for a reference', () => {
  assert.match(SYSTEM_PROMPT, /refund, dispute or cancellation[^.]*escalate on that turn/i);
});
test('row 18: a frustrated caller is escalated on that turn', () => {
  assert.match(SYSTEM_PROMPT, /frustrated[^.]*escalate on that turn/i);
});
test('row 21: the escalation is created as soon as there is a name and email, and the tool checks the time', () => {
  assert.match(SYSTEM_PROMPT, /as soon as you have the name and email, call create_escalation/i);
});
test('only frustration and declines are logged as events: anything else is a wasted round trip', () => {
  assert.match(SYSTEM_PROMPT, /log nothing else/i);
});

test('row 11: an answer from a lookup cites the reference the tool returned', () => {
  assert.match(SYSTEM_PROMPT, /cite the reference the lookup returned/i);
});
test('row 17: the escalation category follows the issue, and a refund is a dispute', () => {
  assert.match(SYSTEM_PROMPT, /dispute for a refund/i);
});
test('brief 6: a ticket needs no contact details, so asking to log an issue creates the ticket on that turn', () => {
  assert.match(SYSTEM_PROMPT, /ticket needs no contact details/i);
});
test('row 14: a contact name and a company name are two identifiers, not one', () => {
  assert.match(SYSTEM_PROMPT, /a contact name and a company name are two identifiers/i);
});

test('a reference spoken in pieces over several turns is joined before the lookup', () => {
  assert.match(SYSTEM_PROMPT, /join the pieces into one reference before you look it up/i);
});

test('a taken time is reported and the caller picks from next_slots; the agent never books one for them', () => {
  assert.match(SYSTEM_PROMPT, /Book one only after the caller picks it, on their next turn; never choose one for them/);
});
