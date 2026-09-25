import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capReached, agentCostFloorUsd } from '../../lib/agent/caps.ts';
import { config } from '../../lib/config.ts';

/**
 * The SDK reports a cap two different ways, and only one was handled.
 *
 * `runAgent` mapped `error_max_budget_usd` to a partial run with a shortfall
 * reason, but that code sits AFTER the `for await` loop. On 2026-09-25 the SDK
 * did not yield a result message, it threw:
 *
 *   Claude Code returned an error result: Reached maximum budget ($1.5)
 *
 * The exception escaped the loop, so the cost was never recorded, model_usage
 * was never written, and the worker's catch marked a run holding 8 qualified
 * leads and 16 drafts as `failed` with no shortfall reason.
 */

test('a cap reported as a result subtype is recognised', () => {
  assert.equal(capReached('error_max_budget_usd', undefined), 'error_max_budget_usd');
  assert.equal(capReached('error_max_turns', undefined), 'error_max_turns');
});

test('a cap reported as a thrown message is recognised as the same cap', () => {
  assert.equal(
    capReached(undefined, 'Claude Code returned an error result: Reached maximum budget ($1.5)'),
    'error_max_budget_usd');
  assert.equal(
    capReached(undefined, 'Reached maximum number of turns (60)'),
    'error_max_turns');
});

test('an unrelated failure is not dressed up as a cap', () => {
  // A genuine crash must stay a crash. Reporting an overload as "reached its
  // spend cap" would tell a reviewer the run finished within its budget.
  assert.equal(capReached(undefined, 'ECONNRESET'), null);
  assert.equal(capReached('success', undefined), null);
  assert.equal(capReached(undefined, undefined), null);
});

/**
 * A run that stopped BECAUSE it hit its spend cap spent at least that cap.
 *
 * On the thrown path there is no result message, so the SDK's own cost figure
 * never arrives and `costUsd` is 0. Recording 0 is how a $1.50 run was booked
 * at $0.073. Same reasoning as the Apify settlement floor: the known-minimum
 * is recorded rather than the convenient zero.
 */
test('a run stopped by the spend cap is never recorded as free', () => {
  const floor = agentCostFloorUsd(0, 'error_max_budget_usd');
  assert.equal(floor, config.limits.maxBudgetUsd);
  assert.ok(floor > 0);
});

test('a reported cost above the cap is kept, because it is the better figure', () => {
  assert.equal(agentCostFloorUsd(2.75, 'error_max_budget_usd'), 2.75);
});

test('a turn cap says nothing about spend, so no floor is invented', () => {
  // Hitting 60 turns cheaply is possible. Only the spend cap implies a spend.
  assert.equal(agentCostFloorUsd(0.4, 'error_max_turns'), 0.4);
  assert.equal(agentCostFloorUsd(0, 'error_max_turns'), 0);
});

test('an ordinary run records what was reported, and never a negative', () => {
  assert.equal(agentCostFloorUsd(0.73, null), 0.73);
  assert.equal(agentCostFloorUsd(-1, null), 0);
  assert.equal(agentCostFloorUsd(Number.NaN, null), 0);
});
