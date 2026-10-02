import { fileURLToPath } from 'node:url';
import { query as sdkQuery, STRUCTURED_OUTPUT_TOOL, type Options, type SDKUserMessage } from './sdk.ts';
import { config } from '../lib/config.ts';
import { REPLY_JSON_SCHEMA } from '../lib/gates/reply.ts';
import { one } from '../lib/db.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { makePreToolUseHook } from './hooks.ts';
import { AsyncQueue } from './queue.ts';
import type { AgentRuntime, AgentSession, RuntimeEvent, SessionState } from './runtime.ts';

const WORKSPACE = fileURLToPath(new URL('./workspace/', import.meta.url));
const ENV_PASSTHROUGH = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_OPTIONS'];
const BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'Skill'];

export const hasOpenEscalation = async (conversationId: string) =>
  !!(await one(`select 1 from public.escalations where conversation_id = $1 and status <> 'closed'`, [conversationId]));

export function buildQueryOptions(conversationId: string, state: SessionState,
  opts: { model?: string; mcpFault?: 'mcp_down' | 'calendar_down' | null }): Options {
  const model = opts.model ?? config.models.agent;
  const fault = config.agent.allowFaults ? opts.mcpFault ?? null : null;
  const env: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ANTHROPIC_API_KEY: config.anthropic.key };
  for (const k of ENV_PASSTHROUGH) if (process.env[k]) env[k] = process.env[k]!;
  const headers: Record<string, string> = { authorization: `Bearer ${config.agent.mcpToken}`, 'x-conversation-id': conversationId };
  if (fault === 'calendar_down') headers['x-relaypay-fault'] = 'calendar_down';
  return {
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    disallowedTools: BUILTINS,
    allowedTools: ['mcp__relaypay__*'],
    canUseTool: async (name: string, input: Record<string, unknown>) => name.startsWith('mcp__relaypay__')
      ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only RelayPay support tools are available.' },
    // 20 s: an escalation makes two Cal.com calls in turn, then Discord and email together, 5 s each at most. Slower than that is a
    // tool error the agent turns into the failure line (spec §12), not a caller left in silence.
    mcpServers: { relaypay: { type: 'http', url: fault === 'mcp_down' ? 'http://127.0.0.1:9/mcp' : config.agent.mcpUrl, headers, timeout: 20_000 } },
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: 'default',
    cwd: WORKSPACE,
    env,
    maxBudgetUsd: config.agent.maxBudgetUsd,
    maxTurns: config.agent.maxTurns,
    outputFormat: { type: 'json_schema', schema: REPLY_JSON_SCHEMA },
    hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(state, hasOpenEscalation)] }] },
    persistSession: false,
    ...(model === 'claude-sonnet-5' ? { effort: config.models.effort } : {}),
  } as Options;
}

class ClaudeSession implements AgentSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private iter: AsyncIterator<any>;
  private q: any;
  private costSoFar = 0;
  constructor(readonly conversationId: string, readonly model: string, readonly state: SessionState, queryFn: typeof sdkQuery, options: Options) {
    this.q = queryFn({ prompt: this.queue, options });
    this.iter = this.q[Symbol.asyncIterator]();
  }
  async *turn(text: string): AsyncGenerator<RuntimeEvent> {
    this.state.toolCallsThisTurn = 0;
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage);
    let mcpDown = false;
    for (;;) {
      const { value: m, done } = await this.iter.next();
      if (done) { yield { kind: 'result', ok: false, subtype: 'session_closed', costUsd: 0, durationMs: 0 }; return; }
      // Only RelayPay tools start a tool: StructuredOutput is how the reply itself arrives (SPIKE.md).
      if (m.type === 'assistant') for (const b of m.message?.content ?? [])
        if (b.type === 'tool_use' && b.name !== STRUCTURED_OUTPUT_TOOL && String(b.name).startsWith('mcp__relaypay__')) yield { kind: 'tool_start', tool: b.name };
      // Spec §12: without its tools the agent must not improvise, so a RelayPay server that did not
      // connect fails the turn, and the caller hears the failure line instead of a guess.
      if (m.type === 'system' && m.subtype === 'init')
        mcpDown = !(m.mcp_servers ?? []).some((x: any) => x.name === 'relaypay' && x.status === 'connected');
      if (m.type === 'result') {
        const total = Number(m.total_cost_usd ?? 0); const costUsd = Math.max(0, total - this.costSoFar); this.costSoFar = total;
        if (m.subtype === 'error_max_budget_usd') this.state.budgetExhausted = true;
        if (mcpDown) { yield { kind: 'result', ok: false, subtype: 'mcp_unavailable', costUsd, durationMs: m.duration_ms ?? 0 }; return; }
        yield m.subtype === 'success'
          ? { kind: 'result', ok: true, output: m.structured_output, costUsd, durationMs: m.duration_ms ?? 0 }
          : { kind: 'result', ok: false, subtype: m.subtype, costUsd, durationMs: m.duration_ms ?? 0 };
        return;
      }
    }
  }
  async interrupt() { await this.q.interrupt?.(); }
  async close() { this.queue.end(); this.q.close?.(); }
}

export function claudeRuntime(queryFn: typeof sdkQuery = sdkQuery): AgentRuntime {
  return { async open(conversationId, opts = {}) {
    const state: SessionState = { conversationId, toolCallsThisTurn: 0, budgetExhausted: false };
    const options = buildQueryOptions(conversationId, state, opts);
    return new ClaudeSession(conversationId, options.model as string, state, queryFn, options);
  } };
}
