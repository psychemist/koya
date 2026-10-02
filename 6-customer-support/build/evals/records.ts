import { one, query } from '../lib/db.ts';

export type TurnRow = { seq: number; user_transcript: string; assistant_response: string; answer_type: string; status: string;
  citations: string[]; gate_result: { attempts?: number; violations?: { gate: string; detail: string }[] }; latency_ms: number | null; cost_usd: string };
export type ToolCallRow = { tool_name: string; status: string; input_summary: any; result_summary: any; created_at?: Date };
export type RetrievalRow = { query: string; chunk_ids: string[]; grounded: boolean; degraded: boolean };
export type TicketRow = { ticket_ref: string; category?: string; status?: string };
export type EscalationRow = { escalation_ref: string; category: string; user_email: string; call_booked: boolean; booking_status: string;
  appointment_at: Date | null; notify_status: string };
export type EventRow = { event_type: string; summary: string };
export type RunRecord = { conversationId: string; turns: TurnRow[]; toolCalls: ToolCallRow[]; retrievals: RetrievalRow[];
  tickets: TicketRow[]; escalation: EscalationRow | null; events: EventRow[]; conversation: any };

/** Everything a scenario is graded on, read back from the rows the run wrote. Nothing is taken from the agent's own account. */
export async function loadRecords(conversationId: string): Promise<RunRecord> {
  const [turns, toolCalls, retrievals, tickets, escalation, events, conversation] = await Promise.all([
    query<TurnRow>('select * from public.conversation_turns where conversation_id = $1 order by seq', [conversationId]),
    query<ToolCallRow>('select tool_name, status, input_summary, result_summary, created_at from public.tool_calls where conversation_id = $1 order by created_at', [conversationId]),
    query<RetrievalRow>('select query, chunk_ids, grounded, degraded from public.retrieval_logs where conversation_id = $1 order by created_at', [conversationId]),
    query<TicketRow>('select ticket_ref, category, status from public.support_tickets where conversation_id = $1 order by created_at', [conversationId]),
    one<EscalationRow>('select * from public.escalations where conversation_id = $1 order by created_at desc limit 1', [conversationId]),
    query<EventRow>('select event_type, summary from public.conversation_events where conversation_id = $1 order by created_at', [conversationId]),
    one<any>('select * from public.conversations where id = $1', [conversationId]),
  ]);
  return { conversationId, turns, toolCalls, retrievals, tickets, escalation, events, conversation };
}

/** Row 10: the run as a whole wrote to every table the PRD lists. */
export async function runLevelLogging(evalRunId: string, conversationIds: string[]): Promise<{ passed: boolean; actual: string; notes: string }> {
  const count = async (sql: string) => Number((await one<{ n: string }>(sql, [conversationIds]))!.n);
  const counts = {
    conversations: conversationIds.length,
    conversation_turns: await count('select count(*) n from public.conversation_turns where conversation_id = any($1)'),
    retrieval_logs: await count('select count(*) n from public.retrieval_logs where conversation_id = any($1)'),
    tool_calls: await count('select count(*) n from public.tool_calls where conversation_id = any($1)'),
    support_tickets: await count('select count(*) n from public.support_tickets where conversation_id = any($1)'),
    escalations: await count('select count(*) n from public.escalations where conversation_id = any($1)'),
    conversation_events: await count('select count(*) n from public.conversation_events where conversation_id = any($1)'),
    evaluations: Number((await one<{ n: string }>('select count(*) n from public.evaluations where eval_run_id = $1', [evalRunId]))!.n),
  };
  const silent = await query<{ id: string }>(`select c.id from public.conversations c where c.id = any($1)
    and not exists (select 1 from public.conversation_turns t where t.conversation_id = c.id)`, [conversationIds]);
  const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k);
  const notes = [empty.length ? `no rows in: ${empty.join(', ')}` : '', silent.length ? `${silent.length} conversation(s) with no turn` : '']
    .filter(Boolean).join('; ');
  return { passed: !notes, actual: Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', '), notes };
}
