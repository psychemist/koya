import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheReadTokens } from '../../lib/agent/run-agent.ts';
import { query } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

test('cache reads are summed across whatever shape the SDK reports', () => {
  assert.equal(cacheReadTokens({
    'claude-sonnet-5': { cache_read_input_tokens: 120_000, input_tokens: 4_000 },
    'claude-haiku-4-5': { cache_read_input_tokens: 800 },
  }), 120_800);
  assert.equal(cacheReadTokens({ 'claude-sonnet-5': { cacheReadInputTokens: 50 } }), 50);
  // A run that resent the frozen prefix every turn reads as zero, which is
  // the point: this number exists to make that visible.
  assert.equal(cacheReadTokens({ 'claude-sonnet-5': { input_tokens: 300_000 } }), 0);
  assert.equal(cacheReadTokens(null), 0);
});

/**
 * Asserts the claim against real runs once any exist.
 *
 * It skips rather than failing on a database with no completed agent run,
 * because forcing a paid agent loop on every test invocation is not a thing a
 * test suite should do. Once one run has completed, this becomes a real
 * assertion and stays one.
 */
test('a completed run shows the system prompt and skills were read from cache',
  { skip: skipWithoutDatabase }, async (t) => {
    const runs = await query<{ id: string; model_usage: unknown; agent_turns: number }>(
      `select id, model_usage, agent_turns from public.runs
        where model_usage is not null and agent_turns > 1
        order by created_at desc limit 1`);

    if (!runs.length) {
      t.skip('no completed agent run has been recorded yet');
      return;
    }

    const read = cacheReadTokens(runs[0].model_usage);
    assert.ok(read > 0,
      `run ${runs[0].id} ran ${runs[0].agent_turns} turns and read 0 tokens from cache, ` +
      'so the frozen prefix is being resent every turn');
  });
