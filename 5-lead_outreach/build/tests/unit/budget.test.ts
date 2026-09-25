import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampCandidates, clampScrapes, clampTargetLeads, discoveryCallsLeft,
  dailyClaudeRefusal, budgetConfigError,
} from '../../lib/budget.ts';
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

/**
 * How many searches a run may pay to start.
 *
 * The run of 2026-09-25 made twenty-one discovery calls for forty charged
 * rows. Three of the first six returned nothing and still paid the
 * $0.001 start fee, and every call also lengthened the transcript that all
 * later turns pay to re-send. Turn count is where an agent loop's cost
 * compounds, and this is the largest avoidable contributor to it.
 */
test('a run may search several times, because the first query is rarely right', () => {
  assert.ok(discoveryCallsLeft(0) > 1);
  assert.equal(discoveryCallsLeft(0), config.limits.discoveryCalls);
});

test('the allowance runs out, and cannot go negative', () => {
  const cap = config.limits.discoveryCalls;
  assert.equal(discoveryCallsLeft(cap - 1), 1);
  assert.equal(discoveryCallsLeft(cap), 0);
  assert.equal(discoveryCallsLeft(cap + 9), 0);
});

test('a nonsense count is treated as none used rather than as unlimited', () => {
  // A failed count must not hand out an unbounded allowance.
  for (const v of [NaN, -1, undefined])
    assert.equal(discoveryCallsLeft(v as number), config.limits.discoveryCalls);
});

/**
 * The cap Claude did not have.
 *
 * Apify is bounded per run AND per day. Claude, the most expensive provider by
 * far at roughly 89% of a run's cost, was bounded only per run, so ten runs in
 * a day was $15 with nothing to stop it.
 *
 * The check reserves a whole run's ceiling rather than waiting for the day to
 * be over the line, because a cap that can be overshot by a full run is not a
 * cap.
 */
const CAP = config.limits.dailyClaudeCapUsd;
const RUN = config.limits.maxBudgetUsd;

test('a day with room for a whole run allows it', () => {
  assert.equal(dailyClaudeRefusal(0), null);
  assert.equal(dailyClaudeRefusal(CAP - RUN), null);
});

test('a day that cannot fund another whole run refuses it, and says so', () => {
  const refusal = dailyClaudeRefusal(CAP - RUN + 0.01);
  assert.ok(refusal, 'a run that could exceed the daily cap was allowed to start');
  assert.match(refusal, /daily/i);
  assert.ok(refusal.includes(CAP.toFixed(2)), 'the refusal does not name the cap');
});

test('an already exhausted day refuses', () => {
  assert.ok(dailyClaudeRefusal(CAP));
  assert.ok(dailyClaudeRefusal(CAP * 2));
});

test('a spend figure that cannot be read fails closed', () => {
  // A glitched count must not read as an empty day and hand out a run.
  for (const v of [NaN, Infinity, -1])
    assert.ok(dailyClaudeRefusal(v as number), `${v} was treated as room to spend`);
});

/**
 * Two caps that can never agree.
 *
 * A daily cap below one run's ceiling refuses every run for ever while reading
 * exactly like an ordinary exhausted day, so the reader goes looking at
 * today's spend rather than at the two numbers in conflict.
 */
test('a per-run budget larger than the daily cap is named as a misconfiguration', () => {
  const err = budgetConfigError(3.50, 2.50);
  assert.ok(err);
  assert.match(err, /AGENT_MAX_BUDGET_USD/);
  assert.match(err, /DAILY_CLAUDE_CAP_USD/);
  assert.ok(err.includes('3.50') && err.includes('2.50'));
});

test('a per-run budget that fits inside the day is not an error', () => {
  assert.equal(budgetConfigError(1.50, 2.50), null);
  assert.equal(budgetConfigError(2.50, 2.50), null, 'exactly one run a day is a choice');
});
