import { one, query } from '../lib/db.ts';
import { redact, redactString } from '../lib/sanitise.ts';
import { toToolError } from '../lib/errors.ts';

/**
 * The tool-call log is written by this wrapper, not by the agent, so a call that
 * throws halfway still leaves a record of what was being attempted. The started
 * row is committed BEFORE the handler runs.
 */
export async function withToolCall<T extends object>(conversationId: string | null, tool: string, purpose: string | undefined,
  input: unknown, fn: () => Promise<{ result: T; summary: Record<string, unknown> }>): Promise<T> {
  const started = Date.now();
  const row = await one<{ id: string }>(
    `insert into public.tool_calls (conversation_id, tool_name, purpose, input_summary, status)
     values ($1,$2,$3,$4,'started') returning id`,
    [conversationId, tool, purpose?.slice(0, 200) ?? null, JSON.stringify(redact(input))]);
  try {
    const { result, summary } = await fn();
    await query(`update public.tool_calls set status='ok', result_summary=$2, duration_ms=$3 where id=$1`,
      [row!.id, JSON.stringify(redact(summary)), Date.now() - started]);
    return result;
  } catch (e) {
    const te = toToolError(e);
    await query(`update public.tool_calls set status=$2, error_code=$3, error_message=$4, result_summary=$5, duration_ms=$6 where id=$1`,
      [row!.id, te.denied ? 'denied' : 'error', te.code, redactString(te.message).slice(0, 500),
       te.details ? JSON.stringify(redact(te.details)) : null, Date.now() - started]);
    throw te;
  }
}
