import { query } from '../../lib/db.ts';
import type { AgentRuntime, RuntimeEvent } from '../../agent/runtime.ts';

type Step = RuntimeEvent[] | ((text: string) => RuntimeEvent[] | Promise<RuntimeEvent[]>);

/**
 * A runtime that replays a script, one entry per model turn, across every
 * session it opens. A function entry sees the prompt, so tests can assert on
 * what the pipeline sent. An exhausted script is a failed result.
 */
export function fakeRuntime(script: Step[]): AgentRuntime {
  let i = 0;
  return { async open(conversationId) { return {
    conversationId, model: 'fake',
    async *turn(text: string) {
      const step = script[i++];
      const events = step === undefined
        ? [{ kind: 'result', ok: false, subtype: 'script_exhausted', costUsd: 0, durationMs: 0 } as RuntimeEvent]
        : typeof step === 'function' ? await step(text) : step;
      for (const e of events) yield e;
    },
    async interrupt() {}, async close() {},
  }; } };
}

/** Stands in for the MCP server's wrapper: one ok tool_calls row with this result summary. */
export async function logToolCall(conversationId: string, tool: string, resultSummary: object, inputSummary: object = {}): Promise<void> {
  await query(`insert into public.tool_calls (conversation_id, tool_name, purpose, input_summary, result_summary, status, duration_ms)
    values ($1, $2, 'test', $3, $4, 'ok', 1)`, [conversationId, tool, JSON.stringify(inputSummary), JSON.stringify(resultSummary)]);
}

/** Task 14b: every turn of every session takes the next scripted response in order; a plain clarify when empty. */
export function queueRuntime() {
  const prompts: string[] = [];
  const queue: Array<(text: string, conversationId: string) => RuntimeEvent[] | Promise<RuntimeEvent[]>> = [];
  let opened = 0;
  const fallback = (): RuntimeEvent[] => [{ kind: 'result', ok: true, costUsd: 0.001, durationMs: 5, output: { answer_type: 'clarify',
    spoken_response: 'Could you tell me a little more?', citations: [], confidence_note: 'queue default', escalation_category: null } }];
  const runtime: AgentRuntime = { async open(conversationId) { opened++; return {
    conversationId, model: 'fake',
    async *turn(text: string) { prompts.push(text); for (const e of await (queue.shift() ?? fallback)(text, conversationId)) yield e; },
    async interrupt() {}, async close() {},
  }; } };
  return { runtime, prompts, next: (fn: (typeof queue)[number]) => { queue.push(fn); }, get opened() { return opened; } };
}
