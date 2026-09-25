import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingRunBudgetUsd, tooLittleLeftToStart, MIN_AGENT_BUDGET_USD,
} from '../../lib/agent/caps.ts';
import { config } from '../../lib/config.ts';

const CAP = config.limits.maxBudgetUsd;

/**
 * The gap this closes: `AGENT_MAX_BUDGET_USD` was handed to the SDK as a flat
 * number on every invocation, but a run interrupted mid-flight is reclaimed
 * after the lease expires and invoked AGAIN. Three reclaims meant three times
 * the per-run cap, with only the daily cap standing behind it.
 */

test('a fresh run gets the whole per-run cap', () => {
  assert.equal(remainingRunBudgetUsd(0), CAP);
});

test('a reclaimed run gets only what its cap has left', () => {
  assert.equal(remainingRunBudgetUsd(CAP * 0.25), CAP * 0.75);
});

test('numeric columns arrive from pg as strings and must still subtract', () => {
  assert.equal(remainingRunBudgetUsd(String(CAP * 0.5)), CAP * 0.5);
});

test('a run already at its cap has nothing left, never a negative allowance', () => {
  assert.equal(remainingRunBudgetUsd(CAP), 0);
  assert.equal(remainingRunBudgetUsd(CAP * 2), 0);
});

test('an unparseable spend is treated as nothing spent rather than crashing a run', () => {
  assert.equal(remainingRunBudgetUsd(Number.NaN), CAP);
  assert.equal(remainingRunBudgetUsd('' as unknown as number), CAP);
});

test('a fresh run is startable', () => {
  assert.equal(tooLittleLeftToStart(remainingRunBudgetUsd(0)), false);
});

test('a run at its cap is not startable', () => {
  assert.equal(tooLittleLeftToStart(remainingRunBudgetUsd(CAP)), true);
});

/**
 * Starting an agent with a few cents buys one turn of thinking and no tool
 * calls, then reports a cap. That is indistinguishable from a real short run
 * in the record, and it costs money to produce nothing.
 */
test('a sliver of budget is not worth an agent invocation', () => {
  assert.equal(tooLittleLeftToStart(MIN_AGENT_BUDGET_USD / 2), true);
});

test('the startable floor is a small fraction of the cap, not most of it', () => {
  assert.ok(MIN_AGENT_BUDGET_USD > 0);
  assert.ok(MIN_AGENT_BUDGET_USD < CAP / 2,
    'the floor is so high that ordinary reclaims would be refused');
});
