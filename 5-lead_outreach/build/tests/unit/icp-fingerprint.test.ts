import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icpFingerprint } from '../../lib/icp.ts';

/**
 * A verdict is a function of (company facts, ICP), so a stored verdict is only
 * reusable against the same ICP. The fingerprint is what makes "the same ICP"
 * a decidable question, and it exists first to MEASURE overlap between runs:
 * whether the reuse subsystem is worth building at all is an open question
 * that one run cannot answer.
 *
 * It covers only what decides a verdict. Two runs that differ solely in who
 * they intend to write to are judging companies identically.
 */
const BASE = {
  industries: ['Software Development', 'SaaS'],
  geography: ['United States'],
  headcount_range: '10 to 100',
  hard_filters: ['Company is B2B', 'Headcount between 10 and 100'],
  disqualifiers: ['Agency or consultancy'],
  buyer_persona: 'Founder or VP Sales',
  business_problem: 'Scaling GTM',
};

test('the same criteria fingerprint the same, whatever order they arrive in', () => {
  const a = icpFingerprint(BASE);
  const b = icpFingerprint({
    ...BASE,
    industries: ['SaaS', 'Software Development'],
    hard_filters: ['Headcount between 10 and 100', 'Company is B2B'],
  });
  assert.equal(a, b, 'array order changed the fingerprint, so no run ever matches another');
});

test('case and surrounding space do not make a new ICP', () => {
  assert.equal(icpFingerprint(BASE), icpFingerprint({
    ...BASE, geography: ['  united states '], headcount_range: '10 TO 100',
  }));
});

test('a different hard filter is a different ICP', () => {
  assert.notEqual(icpFingerprint(BASE),
    icpFingerprint({ ...BASE, hard_filters: ['Company is B2C'] }));
});

test('a different industry, geography or headcount is a different ICP', () => {
  for (const patch of [
    { industries: ['Financial Services'] },
    { geography: ['United Kingdom'] },
    { headcount_range: '200 to 500' },
    { disqualifiers: [] },
  ]) assert.notEqual(icpFingerprint(BASE), icpFingerprint({ ...BASE, ...patch }),
    `${JSON.stringify(patch)} did not change the fingerprint`);
});

test('who the outreach is addressed to does not change who qualifies', () => {
  // Persona and problem shape the copy, not the verdict. Folding them in
  // would make two identically judged runs look unrelated.
  assert.equal(icpFingerprint(BASE), icpFingerprint({
    ...BASE, buyer_persona: 'Head of Customer Success', business_problem: 'Churn',
  }));
});

test('an absent or unusable ICP still yields a stable key', () => {
  assert.equal(icpFingerprint(null), icpFingerprint(undefined));
  assert.equal(icpFingerprint({}), icpFingerprint(null));
  assert.match(icpFingerprint(null), /^[0-9a-f]{16,}$/);
});
