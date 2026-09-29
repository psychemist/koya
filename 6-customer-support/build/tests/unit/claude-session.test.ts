// A fake query() that replays scripted SDK messages, so the session parser is tested without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// buildQueryOptions reads these; test values, never real ones.
Object.assign(process.env, { MCP_URL: 'http://mcp.test/mcp', MCP_TOKEN: 't', ANTHROPIC_API_KEY: 'sk-ant-test' });
const { claudeRuntime } = await import('../../agent/claude-runtime.ts');

function fakeQuery(turns: any[][]) {
  return ({ prompt }: any) => {
    const it = prompt[Symbol.asyncIterator]();
    async function* gen() { for (const t of turns) { await it.next(); for (const m of t) yield m; } }
    const g: any = gen(); g.interrupt = async () => {}; g.close = () => {}; return g;
  };
}

test('tool_use blocks become tool_start events, and each turn ends at its own result', async () => {
  const rt = claudeRuntime(fakeQuery([
    [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__relaypay__search_knowledge_base', input: {} }] } },
     { type: 'result', subtype: 'success', structured_output: { answer_type: 'answer' }, total_cost_usd: 0.002, duration_ms: 900 }],
    [{ type: 'result', subtype: 'success', structured_output: { answer_type: 'clarify' }, total_cost_usd: 0.003, duration_ms: 400 }],
  ]) as any);
  const s = await rt.open('c');
  const t1: any[] = []; for await (const e of s.turn('fees?')) t1.push(e);
  assert.deepEqual(t1.map((e) => e.kind), ['tool_start', 'result']);
  const t2: any[] = []; for await (const e of s.turn('stuck')) t2.push(e);
  assert.equal(t2[0].output.answer_type, 'clarify');
});

test('a cumulative total_cost_usd is reported per turn as the difference', async () => {
  const rt = claudeRuntime(fakeQuery([
    [{ type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.002, duration_ms: 1 }],
    [{ type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.005, duration_ms: 1 }],
  ]) as any);
  const s = await rt.open('c'); const costs: number[] = [];
  for (const t of ['a', 'b']) for await (const e of s.turn(t)) if (e.kind === 'result') costs.push(e.costUsd);
  assert.deepEqual(costs.map((c) => +c.toFixed(3)), [0.002, 0.003]);
});

test('an error subtype is a failed result, not a thrown exception', async () => {
  const rt = claudeRuntime(fakeQuery([[{ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 0.25, duration_ms: 1 }]]) as any);
  const s = await rt.open('c'); const ev: any[] = []; for await (const e of s.turn('x')) ev.push(e);
  assert.deepEqual([ev[0].ok, ev[0].subtype], [false, 'error_max_budget_usd']);
});

test('the StructuredOutput tool call that carries the reply is not a tool_start, so no filler is spoken for it (SPIKE.md)', async () => {
  const rt = claudeRuntime(fakeQuery([[
    { type: 'system', subtype: 'init', mcp_servers: [] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } },
    { type: 'result', subtype: 'success', structured_output: { answer_type: 'answer' }, total_cost_usd: 0.001, duration_ms: 1 }]]) as any);
  const s = await rt.open('c'); const ev: any[] = []; for await (const e of s.turn('hi')) ev.push(e);
  assert.deepEqual(ev.map((e) => e.kind), ['result']);
});

test('each turn resets the per-turn tool count', async () => {
  const rt = claudeRuntime(fakeQuery([
    [{ type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.001, duration_ms: 1 }],
    [{ type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.002, duration_ms: 1 }]]) as any);
  const s: any = await rt.open('c');
  for await (const _ of s.turn('a')) { /* drain */ }
  s.state.toolCallsThisTurn = 4;
  for await (const _ of s.turn('b')) { /* drain */ }
  assert.equal(s.state.toolCallsThisTurn, 0);
});
