import { query } from './db.ts';
import { redact, redactString } from './sanitise.ts';
import { isBudgetDenial } from './errors.ts';

export type ToolCallOutcome<T> = {
  value: T;
  resultSummary: unknown;
  costUsd?: number;
};

/**
 * The tool-call log is written by the wrapper, not by the agent, so a call that
 * throws halfway still leaves a record of what was being attempted.
 *
 * A budget refusal is logged as `denied` rather than `error`. The difference
 * matters in review: `error` is something that went wrong, `denied` is the
 * cage doing its job.
 */
export async function withToolCall<T>(
  runId: string,
  toolName: string,
  purpose: string,
  input: unknown,
  fn: () => Promise<ToolCallOutcome<T>>,
): Promise<T> {
  const started = Date.now();
  const [row] = await query<{ id: string }>(
    `insert into public.tool_calls (run_id, tool_name, purpose, input_summary, status)
     values ($1,$2,$3,$4,'started') returning id`,
    [runId, toolName, purpose, JSON.stringify(redact(input))],
  );

  try {
    const { value, resultSummary, costUsd = 0 } = await fn();
    await query(
      `update public.tool_calls
          set status='ok', result_summary=$2, cost_usd=$3, duration_ms=$4
        where id=$1`,
      [row.id, JSON.stringify(redact(resultSummary)), costUsd, Date.now() - started],
    );
    return value;
  } catch (e: any) {
    await query(
      `update public.tool_calls
          set status=$2, error_code=$3, error_message=$4, duration_ms=$5
        where id=$1`,
      [row.id, isBudgetDenial(e) ? 'denied' : 'error', e?.code ?? 'UNKNOWN',
       redactString(String(e?.message ?? e)), Date.now() - started],
    );
    throw e;
  }
}

export async function toolCalls(runId: string) {
  return query(
    'select * from public.tool_calls where run_id = $1 order by created_at',
    [runId],
  );
}
