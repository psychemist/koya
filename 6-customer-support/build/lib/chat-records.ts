import { one } from './db.ts';
import { describeSlot } from './hours.ts';
export type ChatRecords = { ticket_ref: string | null; escalation_ref: string | null; call_booked: boolean; appointment: string | null };
/** Built from rows, never from the model's words, so a reference shown to the customer is one that exists. */
export async function chatRecords(conversationId: string): Promise<ChatRecords> {
  const t = await one<{ ticket_ref: string }>(
    `select ticket_ref from public.support_tickets where conversation_id = $1 order by created_at desc limit 1`, [conversationId]);
  const e = await one<{ escalation_ref: string; call_booked: boolean; appointment_at: Date | null; caller_timezone: string | null }>(
    `select escalation_ref, call_booked, appointment_at, caller_timezone from public.escalations
     where conversation_id = $1 order by created_at desc limit 1`, [conversationId]);
  return { ticket_ref: t?.ticket_ref ?? null, escalation_ref: e?.escalation_ref ?? null, call_booked: !!e?.call_booked,
    appointment: e?.call_booked && e.appointment_at ? describeSlot(e.appointment_at, e.caller_timezone) : null };
}
