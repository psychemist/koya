import { z } from 'zod/v4';
import { config } from '../../lib/config.ts';
import { one, query } from '../../lib/db.ts';
import { ToolError } from '../../lib/errors.ts';
import { normalizeSpokenEmail } from '../../lib/identity.ts';
import { normalizeRef } from '../../lib/refs.ts';
import { describeSlot, isValidTimezone, nextSlots, validateSlot, type SlotCheck } from '../../lib/hours.ts';
import { dispatchNotification } from '../../lib/escalations/dispatch.ts';
import { currentContext } from '../context.ts';
import type { ToolSpec } from '../define.ts';

const input = z.object({
  ticket_id: z.string().max(40).optional().describe('The RP-T- reference from create_support_ticket, if one was made.'),
  customer_id: z.string().max(40).optional().describe('Only a customer verified on this call is attached.'),
  user_name: z.string().trim().min(1).max(120),
  user_email: z.string().trim().min(3).max(200).describe('As the caller gave it; "amara at lagos ledger dot example" is fine.'),
  category: z.enum(['compliance', 'account', 'dispute', 'payment', 'other']),
  reason: z.string().trim().min(5).max(500).describe('Why a specialist is needed, in one or two sentences.'),
  preferred_time: z.string().max(40).optional().describe('ISO 8601 WITH an offset, for example 2026-10-06T14:00:00Z.'),
  preferred_time_text: z.string().max(120).optional().describe('The time as the caller said it.'),
  caller_timezone: z.string().max(60).optional().describe('IANA name if the caller gave one, for example Africa/Lagos.'),
});

type EscRow = { id: string; escalation_ref: string; user_name: string; call_booked: boolean; appointment_at: Date | null;
  booking_status: string; notify_status: string; caller_timezone: string | null };

const TIME_ISSUE: Record<Exclude<SlotCheck, { ok: true }>['code'], string> = {
  TIME_NEEDS_OFFSET: 'I need to know which timezone that time is in. Callbacks run Monday to Friday, 08:00 to 18:00 UTC.',
  TIME_IN_PAST: 'That time has already passed.',
  OUTSIDE_HOURS: 'That time is outside support hours, which are Monday to Friday, 08:00 to 18:00 UTC.',
  INVALID_TIME: 'I could not read that time.',
};
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);

export const escalationTool: ToolSpec<typeof input> = {
  name: 'create_escalation',
  description: 'Hand the case to a human specialist: stores the escalation, requests a callback booking inside support ' +
    'hours, and notifies the support team. Safe to call again in the same conversation to add a missing time. ' +
    'Confirm follow_up_summary to the caller; if next_slots is returned, offer those.',
  input, readOnly: false,
  async run(args, conversationId, opts) {
    const now = opts?.now ?? new Date();
    const email = normalizeSpokenEmail(args.user_email);
    if (!email) throw new ToolError('INVALID_INPUT', 'user_email is not a valid address; ask the caller to spell it');
    const tz = args.caller_timezone && isValidTimezone(args.caller_timezone) ? args.caller_timezone : null;
    const slot = args.preferred_time ? validateSlot(args.preferred_time, now, config.hours) : null;
    const requested = slot?.ok ? slot.start : null;

    const conv = await one<{ verified_customer_id: string | null; channel: string }>(
      'select verified_customer_id, channel from public.conversations where id = $1', [conversationId]);
    const customerId = args.customer_id && normalizeRef(args.customer_id, 'CUS') === conv?.verified_customer_id ? conv!.verified_customer_id : null;
    const ticket = args.ticket_id ? await one<{ id: string }>(
      'select id from public.support_tickets where ticket_ref = $1 and conversation_id = $2', [args.ticket_id.trim().toUpperCase(), conversationId]) : null;

    // Always stored first, so a bad time or a dead booking lane never loses the hand-off itself.
    const e = (await one<EscRow>(
      `insert into public.escalations (conversation_id, ticket_id, customer_id, user_name, user_email, category, reason,
         preferred_time_text, caller_timezone, requested_slot_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (conversation_id) where status <> 'closed' do update set
         ticket_id = coalesce(public.escalations.ticket_id, excluded.ticket_id),
         customer_id = coalesce(public.escalations.customer_id, excluded.customer_id),
         user_name = excluded.user_name, user_email = excluded.user_email,
         preferred_time_text = coalesce(excluded.preferred_time_text, public.escalations.preferred_time_text),
         caller_timezone = coalesce(excluded.caller_timezone, public.escalations.caller_timezone),
         requested_slot_at = coalesce(excluded.requested_slot_at, public.escalations.requested_slot_at),
         updated_at = now()
       returning id, escalation_ref, (xmax = 0) as inserted`,
      [conversationId, ticket?.id ?? null, customerId, args.user_name, email, args.category, args.reason,
       args.preferred_time_text ?? null, tz, requested]))!;
    if ((e as any).inserted) await query(`insert into public.conversation_events (conversation_id, event_type, source, summary)
      values ($1, 'escalation_triggered', 'system', $2)`, [conversationId, `${e.escalation_ref} ${args.category}`]);

    // One outbox row per (escalation, slot): the unique key is what makes a repeated request one calendar event.
    const slotKey = requested ? requested.toISOString() : 'none';
    if (requested) await query(`update public.escalations set booking_status = 'pending' where id = $1 and booking_status in ('not_requested', 'slot_unavailable', 'failed')`, [e.id]);
    const n = await one<{ id: string }>(`insert into public.notifications (escalation_id, slot_key) values ($1, $2)
      on conflict (escalation_id, slot_key) do nothing returning id`, [e.id, slotKey]);
    let outcome = null;
    if (n) outcome = await dispatchNotification(n.id, { dryRun: conv?.channel === 'eval', fault: currentContext().fault });

    const row = (await one<EscRow>(`select id, escalation_ref, user_name, call_booked, appointment_at, booking_status, notify_status, caller_timezone
      from public.escalations where id = $1`, [e.id]))!;
    const zone = tz ?? row.caller_timezone;
    const offer = (from: Date) => nextSlots(from, 3, config.hours);
    let follow: string, suggestions: Date[] | null = null, timeIssue: string | null = null;
    if (slot && !slot.ok) {
      timeIssue = slot.code; suggestions = slot.suggestions;
      follow = `${TIME_ISSUE[slot.code]} The next free times are ${list(suggestions.map((d) => describeSlot(d, zone)))}.`;
    } else if (row.call_booked && row.appointment_at) {
      follow = `A specialist will call ${row.user_name} on ${describeSlot(row.appointment_at, zone)}. The reference is ${row.escalation_ref}.`;
    } else if (row.booking_status === 'slot_unavailable') {
      suggestions = offer(requested ?? now).filter((d) => d.getTime() !== requested?.getTime()).slice(0, 3);
      follow = `That time has just been taken. Other times I can try are ${list(suggestions.map((d) => describeSlot(d, zone)))}.`;
    } else if (row.notify_status === 'fallback_sent' || row.notify_status === 'failed' || row.booking_status === 'failed' || outcome?.status === 'retry') {
      follow = `A specialist will follow up by email to confirm a time. The reference is ${row.escalation_ref}.`;
    } else {
      follow = `The support team has been told, and a specialist will follow up by email to arrange a time. The reference is ${row.escalation_ref}.`;
    }
    const result = {
      escalation_id: row.escalation_ref, status: 'open', follow_up_summary: follow, call_booked: row.call_booked,
      appointment_time_utc: row.call_booked && row.appointment_at ? row.appointment_at.toISOString() : null,
      booking_status: row.booking_status,
      ...(suggestions ? { next_slots: suggestions.map((d) => describeSlot(d, zone)), next_slots_iso: suggestions.map((d) => d.toISOString()) } : {}),
      ...(timeIssue ? { time_issue: timeIssue } : {}),
    };
    return { result, summary: { ...result, user_email: '[redacted]' } };
  },
};
