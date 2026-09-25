import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampCandidates, clampScrapes, clampTargetLeads } from '../../lib/budget.ts';
import { config } from '../../lib/config.ts';

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

/**
 * How many leads the requester actually asked for.
 *
 * `runs.target_leads` existed from the start and was read by the system
 * prompt, `get_run_state` and `finish_run`, but `POST /api/runs` never wrote
 * it, so every run silently used the column default and nobody could ask for
 * a number. The budgets stay fixed on purpose: a narrow ICP cannot be made
 * productive by spending more on it, and `finish_run` already requires a
 * shortfall reason when the target is missed.
 */
test('a requested target is honoured', () => {
  assert.equal(clampTargetLeads(1), 1);
  assert.equal(clampTargetLeads(10), 10);
  assert.equal(clampTargetLeads(25), 25);
});

test('a target outside the range is pulled back, not refused', () => {
  // Refusing would fail a run at submit time over a number the person can
  // only have guessed at.
  assert.equal(clampTargetLeads(0), 1);
  assert.equal(clampTargetLeads(-4), 1);
  assert.equal(clampTargetLeads(500), 25);
});

test('a form value arrives as a string and still counts', () => {
  assert.equal(clampTargetLeads('12'), 12);
  assert.equal(clampTargetLeads('7.8'), 7);
});

test('no target at all falls back to the configured default', () => {
  for (const v of [undefined, null, '', 'ten', NaN])
    assert.equal(clampTargetLeads(v), config.limits.targetLeads);
});
