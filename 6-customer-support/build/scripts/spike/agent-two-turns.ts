// Task 0, Q3 to Q7. One streaming-input query() against the spike MCP server
// (npm exec tsx scripts/spike/mcp-echo.ts -- --serve on :8788). Needs ANTHROPIC_API_KEY.
// Prints every fact SPIKE.md records. Costs a few cents on Haiku.
import { query, startup, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

class Queue<T> implements AsyncIterable<T> {
  private buf: T[] = []; private waiting: ((r: IteratorResult<T>) => void)[] = []; private done = false;
  push(v: T) { const w = this.waiting.shift(); w ? w({ value: v, done: false }) : this.buf.push(v); }
  end() { this.done = true; for (const w of this.waiting.splice(0)) w({ value: undefined as any, done: true }); }
  [Symbol.asyncIterator]() { return { next: () => this.buf.length ? Promise.resolve({ value: this.buf.shift()!, done: false })
    : this.done ? Promise.resolve({ value: undefined as any, done: true }) : new Promise<IteratorResult<T>>((r) => this.waiting.push(r)) }; }
}

const { $schema: _drop, ...schema } = z.toJSONSchema(z.object({
  answer_type: z.enum(['answer', 'clarify', 'escalate', 'decline']),
  spoken_response: z.string(), citations: z.array(z.string()), confidence_note: z.string(),
  escalation_category: z.enum(['compliance', 'account', 'dispute', 'payment', 'other']).nullable(),
}));
const env: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! };
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]!;
const options: Options = {
  model: 'claude-haiku-4-5',
  systemPrompt: 'You are a test support agent. Reply in the schema. Call tools only when asked.',
  tools: [], allowedTools: ['mcp__relaypay__*'], settingSources: [], strictMcpConfig: true, persistSession: false,
  mcpServers: { relaypay: { type: 'http', url: 'http://localhost:8788/mcp', headers: { 'x-conversation-id': 'spike-1' } } },
  canUseTool: async (name, input) => name.startsWith('mcp__relaypay__') ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'no' },
  outputFormat: { type: 'json_schema', schema: schema as any },
  hooks: { PreToolUse: [{ hooks: [async (i: any) => { console.log('   PreToolUse saw:', i.tool_name); return {}; }] }] },
  maxBudgetUsd: 0.25, env, cwd: new URL('../../agent/workspace/', import.meta.url).pathname,
} as Options;

const t0 = Date.now();
const warm = await startup({ options });
console.log(`startup(options) ready in ${Date.now() - t0} ms`);
const q = new Queue<SDKUserMessage>();
const run = warm.query(q);
const it = run[Symbol.asyncIterator]();
const user = (text: string) => q.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage);

async function turn(label: string, text: string, onToolUse?: () => void) {
  const start = Date.now(); user(text); const tools: string[] = [];
  for (;;) {
    const { value: m, done } = await it.next();
    if (done) { console.log(label, 'STREAM ENDED'); return; }
    if (m.type === 'system' && (m as any).subtype === 'init') console.log('Q3 init mcp_servers:', JSON.stringify((m as any).mcp_servers), 'tools:', (m as any).tools?.filter((t: string) => t.startsWith('mcp__')));
    if (m.type === 'assistant') for (const b of (m as any).message.content) if (b.type === 'tool_use') { tools.push(b.name); onToolUse?.(); }
    if (m.type === 'result') {
      const r: any = m;
      console.log(`${label}: ${Date.now() - start} ms wall, subtype=${r.subtype}, tools=${JSON.stringify(tools)}, total_cost_usd=${r.total_cost_usd}, duration_ms=${r.duration_ms}`);
      console.log(`   structured_output=${JSON.stringify(r.structured_output)?.slice(0, 200)}`);
      return;
    }
  }
}
if (process.env.ONLY_T3) { await turn('T3 one tool', 'Call the echo_header tool, then tell me the value of fromCtx.'); process.exit(0); }
await turn('T1 no tool', 'Hello, what can you help with?');
await turn('T2 no tool', 'Thanks. Say that again in fewer words.');
await turn('T3 one tool', 'Call the echo_header tool, then tell me the value of fromCtx.');
let interruptedAt = 0;
await turn('T4 interrupted', 'Run the slow lookup tool now.', () => { setTimeout(() => { interruptedAt = Date.now(); run.interrupt().catch((e) => console.log('interrupt threw', e.message)); }, 800); });
if (interruptedAt) console.log(`Q7 result arrived ${Date.now() - interruptedAt} ms after interrupt()`);
await turn('T5 after interrupt', 'Are you still there? One short sentence.');
q.end(); run.close?.();
process.exit(0);
