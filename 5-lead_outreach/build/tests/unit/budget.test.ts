import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampCandidates, clampScrapes } from '../../lib/budget.ts';

const run = { candidate_budget: 40, candidates_used: 34 } as any;

test('the agent cannot raise its own limit', () => {
  assert.equal(clampCandidates(run, 500), 6);
  assert.equal(clampCandidates(run, 1000000), 6);
});

test('a smaller request is honoured', () => {
  assert.equal(clampCandidates(run, 3), 3);
});

test('no request at all still yields a hard number, never undefined', () => {
  assert.equal(clampCandidates(run), 6);
});

test('an exhausted budget clamps to zero, and zero is a refusal upstream', () => {
  assert.equal(clampCandidates({ candidate_budget: 40, candidates_used: 40 } as any, 10), 0);
});

test('a negative or non-finite request cannot underflow the clamp', () => {
  assert.equal(clampCandidates(run, -5), 0);
  assert.equal(clampCandidates(run, NaN), 6);
});

test('an overspent counter cannot produce a negative allowance', () => {
  assert.equal(clampCandidates({ candidate_budget: 40, candidates_used: 45 } as any, 5), 0);
});

test('the scrape budget clamps on its own counters, not the candidate ones', () => {
  assert.equal(clampScrapes({ scrape_budget: 30, scrapes_used: 28 } as any), 2);
  assert.equal(clampScrapes({ scrape_budget: 30, scrapes_used: 30 } as any), 0);
});
