import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReply, normalizeSpeech, REPLY_JSON_SCHEMA, type TurnFacts } from '../../lib/gates/reply.ts';

const facts = (p: Partial<TurnFacts> = {}): TurnFacts => ({ groundedChunkIds: new Set(['faq/fees']), escalationRequired: false,
  supportNotes: [], callerText: 'what fees do you charge', knownEmails: [], verifiedCustomerId: null, ...p });
const reply = (p: object = {}) => ({ answer_type: 'answer', spoken_response: 'Fees vary by transaction type, corridor and payment method, and you see them before you confirm.',
  citations: ['faq/fees'], confidence_note: 'Grounded in the fees FAQ.', escalation_category: null, ...p });

test('a grounded, cited, plain answer passes', () => {
  assert.deepEqual(checkReply(reply(), facts()).violations, []);
});

test('G1: a malformed reply is refused with the failing path named', () => {
  const r = checkReply({ answer_type: 'maybe' }, facts());
  assert.equal(r.violations[0].gate, 'G1');
});

test('G2: an answer with no citation is refused', () => {
  assert.equal(checkReply(reply({ citations: [] }), facts()).violations[0].gate, 'G2');
});

test('G2: citing a chunk that was not grounded on this turn is refused, even if it exists', () => {
  const v = checkReply(reply({ citations: ['faq/crypto'] }), facts()).violations;
  assert.ok(v.some((x) => x.gate === 'G2' && /faq\/crypto/.test(x.detail)));
});

test('G2 does not apply to clarify, escalate or decline', () => {
  assert.deepEqual(checkReply(reply({ answer_type: 'decline', citations: [], spoken_response: "I can't answer that confidently." }), facts()).violations, []);
});

test('G3: when a lookup said escalation_required, only escalate passes', () => {
  assert.equal(checkReply(reply(), facts({ escalationRequired: true })).violations[0].gate, 'G3');
  assert.deepEqual(checkReply(reply({ answer_type: 'escalate', citations: [], escalation_category: 'compliance',
    spoken_response: 'This needs a specialist. Could I take your name and email?' }), facts({ escalationRequired: true })).violations, []);
});

test('em and en dashes become commas before any other gate reads the text', () => {
  assert.equal(normalizeSpeech('Fees vary \u2014 by corridor \u2013 and method'), 'Fees vary, by corridor, and method');
  assert.ok(!/[\u2014\u2013]/.test(checkReply(reply({ spoken_response: 'Fees vary \u2014 by corridor.' }), facts()).reply!.spoken_response));
});

test('the JSON schema sent to the SDK carries no $schema dialect, which the CLI refuses (SPIKE.md)', () => {
  assert.ok(!('$schema' in REPLY_JSON_SCHEMA));
  assert.equal((REPLY_JSON_SCHEMA as any).type, 'object');
});

test('G6 and G5 findings are collected together, not just the first', () => {
  const v = checkReply(reply({ spoken_response: 'Your risk score is fine. See https://relaypay.example for more.' }), facts()).violations.map((x) => x.gate);
  assert.ok(v.includes('G5') && v.includes('G6'));
});
