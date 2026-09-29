import { one, query } from './db.ts';

export type Status = 'open' | 'in_progress' | 'closed';
const MOVES: Record<Status, Status[]> = { open: ['in_progress', 'closed'], in_progress: ['closed'], closed: [] };

/** Forward only, and closed is terminal (spec §9): a reopened case is a new escalation, not an edited old one. */
export const canTransition = (from: Status, to: Status) => (MOVES[from] ?? []).includes(to);

export const CHANNEL_LABEL: Record<string, string> = {
  voice_web: 'Voice (web)', voice_phone: 'Voice (phone)', web_text: 'Chat', eval: 'Eval', mcp_direct: 'MCP direct',
};

export async function listConversations(f: { status?: string; channel?: string; limit?: number } = {}) {
  return query<{ id: string; started_at: Date; ended_at: Date | null; channel: string; caller_identifier: string | null;
    final_status: string | null; turn_count: number; cost_usd: string; summary: string | null }>(
    `select id, started_at, ended_at, channel, caller_identifier, final_status, turn_count, cost_usd::text, summary
     from public.conversations
     where ($1::text is null or coalesce(final_status, 'open') = $1) and ($2::text is null or channel = $2)
     order by started_at desc limit $3`, [f.status || null, f.channel || null, Math.min(f.limit ?? 100, 500)]);
}

/** One conversation and every record the PRD lists for it. */
export async function conversationDetail(id: string) {
  const conversation = await one<any>('select * from public.conversations where id::text = $1', [id]);
  if (!conversation) return null;
  const [turns, retrievals, toolCalls, tickets, escalations, events, notifications] = await Promise.all([
    query<any>('select * from public.conversation_turns where conversation_id = $1 order by seq', [id]),
    query<any>('select * from public.retrieval_logs where conversation_id = $1 order by created_at', [id]),
    query<any>('select * from public.tool_calls where conversation_id = $1 order by created_at', [id]),
    query<any>('select * from public.support_tickets where conversation_id = $1 order by created_at', [id]),
    query<any>('select * from public.escalations where conversation_id = $1 order by created_at desc', [id]),
    query<any>('select * from public.conversation_events where conversation_id = $1 order by created_at', [id]),
    query<any>(`select n.* from public.notifications n join public.escalations e on e.id = n.escalation_id
                where e.conversation_id = $1 order by n.created_at`, [id]),
  ]);
  return { conversation, turns, retrievals, toolCalls, tickets, escalation: escalations[0] ?? null, escalations, events, notifications };
}

export async function listTickets(f: { status?: string } = {}) {
  return query<any>(`select t.*, c.channel from public.support_tickets t join public.conversations c on c.id = t.conversation_id
    where ($1::text is null or t.status = $1)
    order by (t.status = 'closed'), array_position(array['urgent','high','normal','low'], t.priority), t.created_at desc limit 200`,
    [f.status || null]);
}

/** The open queue first. The latest outbox error rides along, so a team that was never told is visible. */
export async function listEscalations(f: { status?: string } = {}) {
  return query<any>(`select e.*, (select n.last_error from public.notifications n where n.escalation_id = e.id order by n.created_at desc limit 1) as last_error
    from public.escalations e where ($1::text is null or e.status = $1)
    order by (e.status = 'closed'), (e.status = 'in_progress'), e.created_at desc limit 200`, [f.status || null]);
}

export async function escalationDetail(id: string) {
  const escalation = await one<any>('select * from public.escalations where id::text = $1', [id]);
  if (!escalation) return null;
  const notifications = await query<any>('select * from public.notifications where escalation_id = $1 order by created_at', [id]);
  const ticket = escalation.ticket_id ? await one<any>('select * from public.support_tickets where id = $1', [escalation.ticket_id]) : null;
  return { escalation, notifications, ticket };
}

export async function listEvaluations(runId?: string) {
  return query<any>(`select * from public.evaluations where ($1::uuid is null or eval_run_id = $1::uuid)
    order by created_at desc, scenario_key limit 1000`, [runId || null]);
}

/**
 * One version-safe UPDATE: it only applies if the row is still in the status
 * the person saw. No row back means someone else moved it first (409).
 */
export async function changeStatus(table: 'escalations' | 'support_tickets', id: string, from: Status, to: Status) {
  return one<{ id: string; status: Status }>(
    `update public.${table} set status = $2, updated_at = now() where id::text = $1 and status = $3 returning id, status`, [id, to, from]);
}

export async function currentStatus(table: 'escalations' | 'support_tickets', id: string) {
  return (await one<{ status: Status }>(`select status from public.${table} where id::text = $1`, [id]))?.status ?? null;
}

export async function recordManualEvaluation(e: { scenarioKey: string; scenarioTitle?: string; expected: string; actual: string;
  passed: boolean; notes?: string | null; conversationId?: string | null; evalRunId?: string | null; userId: string }) {
  return (await one<{ id: string }>(
    `insert into public.evaluations (eval_run_id, scenario_key, scenario_title, expected_behavior, actual_behavior, passed, notes, source, conversation_id, created_by)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, 'manual', $8, $9)
     on conflict (eval_run_id, scenario_key) do update set actual_behavior = excluded.actual_behavior, passed = excluded.passed,
       notes = excluded.notes, conversation_id = excluded.conversation_id, created_by = excluded.created_by
     returning id`,
    [e.evalRunId ?? null, e.scenarioKey, e.scenarioTitle || e.scenarioKey, e.expected, e.actual, e.passed, e.notes ?? null, e.conversationId ?? null, e.userId]))!;
}
