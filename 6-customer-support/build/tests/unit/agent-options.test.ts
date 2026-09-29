import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { MCP_URL: 'http://mcp.test/mcp', MCP_TOKEN: 't', ANTHROPIC_API_KEY: 'sk-ant-x', DATABASE_URL: 'postgresql://secret' });
const { buildQueryOptions } = await import('../../agent/claude-runtime.ts');
const o: any = buildQueryOptions('conv-1', { conversationId: 'conv-1', toolCallsThisTurn: 0, budgetExhausted: false }, {});

test('no built-in tool exists: tools is empty, and only relaypay MCP tools are pre-approved', () => {
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.allowedTools, ['mcp__relaypay__*']);
});

test('no local settings, no stray MCP config, no memory', () => {
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('the subprocess never receives the database URL or any key but Anthropic', () => {
  assert.equal(o.env.DATABASE_URL, undefined);
  assert.equal(o.env.MCP_TOKEN, undefined);
  assert.equal(o.env.ANTHROPIC_API_KEY, 'sk-ant-x');
});

test('the MCP connection carries the conversation id and bearer token, and a tool slower than 20 s is an error (spec §12)', () => {
  assert.deepEqual(o.mcpServers.relaypay, { type: 'http', url: 'http://mcp.test/mcp', timeout: 20_000,
    headers: { authorization: 'Bearer t', 'x-conversation-id': 'conv-1' } });
});

test('caps and structured output are set; effort is only sent to Sonnet', () => {
  assert.equal(o.maxBudgetUsd, 0.25);
  assert.equal(o.outputFormat.type, 'json_schema');
  assert.equal(o.model, 'claude-haiku-4-5');
  assert.equal(o.effort, undefined);
  const s: any = buildQueryOptions('c', { conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, { model: 'claude-sonnet-5' });
  assert.equal(s.effort, 'low');
});

test('canUseTool denies anything outside relaypay', async () => {
  assert.equal((await o.canUseTool('Bash', {}, {})).behavior, 'deny');
  assert.equal((await o.canUseTool('mcp__relaypay__lookup_customer', { a: 1 }, {})).behavior, 'allow');
});

test('a fault header is only attached when fault injection is allowed', () => {
  const f: any = buildQueryOptions('c', { conversationId: 'c', toolCallsThisTurn: 0, budgetExhausted: false }, { mcpFault: 'mcp_down' });
  assert.notEqual(f.mcpServers.relaypay.url, 'http://127.0.0.1:9/mcp'); // ALLOW_FAULT_INJECTION is not set here
});
