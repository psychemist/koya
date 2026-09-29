import { one, query } from './db.ts';

export type Channel = 'voice_web' | 'voice_phone' | 'web_text' | 'eval' | 'mcp_direct';
export type FinalStatus = 'resolved' | 'clarified' | 'ticketed' | 'escalated' | 'declined' | 'abandoned' | 'failed';

export type ConversationRow = {
  id: string; vapi_call_id: string | null; channel: Channel; caller_identifier: string | null;
  verified_customer_id: string | null; model: string | null; started_at: Date; ended_at: Date | null;
  ended_reason: string | null; final_status: FinalStatus | null; summary: string | null; turn_count: number;
  cost_usd: string; identity_failures: number; eval_run_id: string | null;
};

/**
 * One conversation per Vapi call, however many webhooks arrive and in whatever
 * order: the events webhook and the first custom-llm request race, and both
 * upsert on vapi_call_id. A null call id (chat, eval, MCP direct) always inserts.
 */
export async function upsertConversation(i: { vapiCallId?: string | null; channel: Channel; callerIdentifier?: string | null;
  model?: string | null; evalRunId?: string | null }): Promise<ConversationRow> {
  if (i.vapiCallId) {
    const row = await one<ConversationRow>(
      `insert into public.conversations (vapi_call_id, channel, caller_identifier, model)
       values ($1,$2,$3,$4)
       on conflict (vapi_call_id) do update set caller_identifier = coalesce(public.conversations.caller_identifier, excluded.caller_identifier)
       returning *`, [i.vapiCallId, i.channel, i.callerIdentifier ?? null, i.model ?? null]);
    return row!;
  }
  return (await one<ConversationRow>(
    `insert into public.conversations (channel, caller_identifier, model, eval_run_id) values ($1,$2,$3,$4) returning *`,
    [i.channel, i.callerIdentifier ?? null, i.model ?? null, i.evalRunId ?? null]))!;
}

/**
 * The call's outcome, from records rather than a model: an escalation
 * outranks a ticket, which outranks anything the agent said.
 */
export function deriveFinalStatus(i: { userTurns: number; answerTypes: string[]; failedTurns: number; hasTicket: boolean; hasEscalation: boolean }): FinalStatus {
  if (i.userTurns === 0) return 'abandoned';
  if (i.hasEscalation) return 'escalated';
  if (i.hasTicket) return 'ticketed';
  if (i.failedTurns >= i.userTurns) return 'failed';
  if (i.answerTypes.at(-1) === 'decline') return 'declined';
  if (i.answerTypes.every((t) => t === 'clarify')) return 'clarified';
  return 'resolved';
}

/** Built in code from the turn and record rows. No model is called for a summary (spec §11.1). */
export function buildSummary(i: { turns: number; answerTypes: string[]; ticketRef: string | null;
  escalation: { ref: string; category: string; booked: boolean; slot: string | null } | null }): string {
  const answered = i.answerTypes.filter((t) => t === 'answer').length;
  const parts = [`${i.turns} ${i.turns === 1 ? 'turn' : 'turns'}.`, answered ? `${answered} answered.` : 'None answered.'];
  if (i.ticketRef) parts.push(`Ticket ${i.ticketRef}.`);
  if (i.escalation) parts.push(`Escalation ${i.escalation.ref} (${i.escalation.category}), ` +
    (i.escalation.booked && i.escalation.slot ? `callback booked for ${i.escalation.slot}.` : 'callback not booked.'));
  return parts.join(' ');
}

/** Once only: a second end-of-call-report, or an idle sweep racing it, returns the row as it already is. */
export async function finalizeConversation(id: string, o: { endedReason?: string } = {}): Promise<ConversationRow> {
  const { describeSlot } = await import('./hours.ts');
  const turns = await query<{ answer_type: string; status: string }>(
    'select answer_type, status from public.conversation_turns where conversation_id = $1 order by seq', [id]);
  const ticket = await one<{ ticket_ref: string }>('select ticket_ref from public.support_tickets where conversation_id = $1 order by created_at limit 1', [id]);
  const esc = await one<{ escalation_ref: string; category: string; call_booked: boolean; appointment_at: Date | null }>(
    'select escalation_ref, category, call_booked, appointment_at from public.escalations where conversation_id = $1 order by created_at desc limit 1', [id]);
  const answerTypes = turns.map((t) => t.answer_type);
  const finalStatus = deriveFinalStatus({ userTurns: turns.length, answerTypes, failedTurns: turns.filter((t) => t.status === 'failed').length,
    hasTicket: !!ticket, hasEscalation: !!esc });
  const summary = buildSummary({ turns: turns.length, answerTypes, ticketRef: ticket?.ticket_ref ?? null,
    escalation: esc ? { ref: esc.escalation_ref, category: esc.category, booked: esc.call_booked,
      slot: esc.appointment_at ? describeSlot(esc.appointment_at) : null } : null });
  const row = await one<ConversationRow>(
    `update public.conversations set ended_at = now(), ended_reason = $2, final_status = $3, summary = $4
     where id = $1 and ended_at is null returning *`, [id, o.endedReason ?? null, finalStatus, summary]);
  return row ?? (await one<ConversationRow>('select * from public.conversations where id = $1', [id]))!;
}
