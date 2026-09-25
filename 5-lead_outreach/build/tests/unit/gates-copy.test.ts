import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCopyGates, isBlocked } from '../../lib/gates/copy.ts';
import { EM_DASH, emDashContext } from '../../lib/gates/house-style.ts';

const SOURCE = 'Acme runs onboarding for mid-market payroll teams and is hiring a ' +
               'revenue operations manager to handle manual invoice reconciliation.';
const ok = {
  step: 1,
  subject: 'Manual invoice reconciliation at Acme',
  body: 'Saw you are hiring a revenue operations manager to handle manual invoice ' +
        'reconciliation. We place AI automation assistants who take that off a ' +
        'team. Worth fifteen minutes?',
};

test('a grounded, clean draft passes', () => {
  assert.equal(isBlocked(runCopyGates(ok, SOURCE)), false);
});

test('an em dash blocks', () => {
  const r = runCopyGates({ ...ok, body: ok.body.replace('. We', ' — we') }, SOURCE);
  assert.ok(isBlocked(r));
  assert.equal(r.find(g => g.gate === 'house-style')?.passed, false);
});

test('a double hyphen substitute blocks too', () => {
  const r = runCopyGates({ ...ok, body: ok.body.replace('. We', ' -- we') }, SOURCE);
  assert.ok(isBlocked(r));
});

test('ungrounded copy blocks even when it reads well', () => {
  const r = runCopyGates(
    { ...ok, body: 'Your growth trajectory is remarkable and your culture stands out. Chat?' },
    SOURCE);
  assert.equal(r.find(g => g.gate === 'grounding')?.passed, false);
  assert.ok(isBlocked(r));
});

test('a banned opener blocks', () => {
  const r = runCopyGates({ ...ok, body: 'I hope this email finds you well. ' + ok.body }, SOURCE);
  assert.equal(r.find(g => g.gate === 'banned-openers')?.passed, false);
});

test('a personal email address in the body blocks', () => {
  const r = runCopyGates({ ...ok, body: ok.body + ' Reach me at jane.doe@acme.co.' }, SOURCE);
  assert.equal(r.find(g => g.gate === 'no-personal-email')?.passed, false);
});

test('fake urgency blocks', () => {
  const r = runCopyGates({ ...ok, body: 'Limited spots. ' + ok.body }, SOURCE);
  assert.equal(r.find(g => g.gate === 'no-fake-urgency')?.passed, false);
});

test('an over-long subject blocks', () => {
  const r = runCopyGates({ ...ok, subject: 'x'.repeat(61) }, SOURCE);
  assert.equal(r.find(g => g.gate === 'length')?.passed, false);
});

test('a send claim blocks', () => {
  const r = runCopyGates({ ...ok, body: 'I have added you to our list. ' + ok.body }, SOURCE);
  assert.equal(r.find(g => g.gate === 'no-send-intent')?.passed, false);
});

test('a calendar auto-book link is a send claim too', () => {
  const r = runCopyGates({ ...ok, body: ok.body + ' Book here: calendly.com/koya/15min' }, SOURCE);
  assert.equal(r.find(g => g.gate === 'no-send-intent')?.passed, false);
});

test('the LinkedIn message is length-checked at 300 characters, not 120 words', () => {
  const li = { step: 0, body: 'Noticed the revenue operations manager opening. We place ' +
                              'AI automation assistants for manual invoice reconciliation.' };
  assert.equal(isBlocked(runCopyGates(li, SOURCE)), false);
  assert.equal(
    runCopyGates({ step: 0, body: 'manual invoice reconciliation ' + 'x'.repeat(300) }, SOURCE)
      .find(g => g.gate === 'length')?.passed, false);
});

test('advisory findings are reported but never block', () => {
  const r = runCopyGates(
    { ...ok, body: ok.body + ' Does that land? Is next week possible? Who owns this?' }, SOURCE);
  assert.equal(isBlocked(r), false);
  assert.ok(r.some(g => g.severity === 'advisory' && !g.passed));
});

/**
 * A headcount range is punctuation between numbers, not a joined clause.
 *
 * The previous pattern matched an en dash anywhere, so "10-100 employees"
 * written with one failed house style. That is the single phrase this product
 * cannot avoid writing: it is in every ICP. Week 4's gate matches an en dash
 * only beside whitespace, and week 5 now does the same.
 */
test('a dash between numbers is not a house style violation', () => {
  const range = 'We work with teams of 10\u2013100 people.';
  assert.equal(EM_DASH.test(range), false, `"${range}" was rejected as an em dash`);
});

test('a dash standing as punctuation still is one', () => {
  for (const v of [
    'We help teams \u2014 quickly \u2014 hire.',
    'We help teams \u2013 quickly.',
    'We help teams -- quickly.',
  ]) assert.equal(EM_DASH.test(v), true, `"${v}" slipped through`);
});

test('the gate names the offending span so it can be fixed in place', () => {
  const hits = emDashContext('Retention is leaking \u2014 and nobody has noticed yet.');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /Retention is leaking/);
});
