import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../lib/config.ts';

test('a missing required secret names itself, and only when it is read', () => {
  const c = loadConfig({});
  assert.throws(() => c.agent.mcpToken, (e: unknown) => e instanceof ConfigError && /MCP_TOKEN/.test((e as Error).message));
});

test('support hours default to Mon to Fri 08:00 to 18:00 UTC in 30 minute slots', () => {
  assert.deepEqual(loadConfig({}).hours, { days: [1, 2, 3, 4, 5], startHour: 8, endHour: 18, slotMinutes: 30 });
});

test('the model allowlist rejects anything but the two routed models', () => {
  assert.throws(() => loadConfig({ AGENT_MODEL: 'claude-opus-5' }).models.agent, /AGENT_MODEL/);
  assert.equal(loadConfig({ AGENT_MODEL: 'claude-sonnet-5' }).models.agent, 'claude-sonnet-5');
});

test('the daily cap must exceed the per-call budget or no call could ever start', () => {
  assert.throws(() => loadConfig({ DAILY_CLAUDE_CAP_USD: '0.10', AGENT_MAX_BUDGET_USD: '0.25' }).agent.dailyCapUsd, /DAILY_CLAUDE_CAP_USD/);
});

test('DATABASE_URL must be a postgres URI, not the https API URL', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'https://abc.supabase.co' }).db.url, /postgresql:\/\//);
});

test('a budget read after the environment changes sees the new value', () => {
  const env: Record<string, string | undefined> = {};
  const c = loadConfig(env);
  assert.equal(c.agent.dailyCapUsd, 5);
  env.DAILY_CLAUDE_CAP_USD = '0.30';
  assert.equal(c.agent.dailyCapUsd, 0.3);
});
