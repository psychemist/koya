import { config } from '../config.ts';
import { one, query } from '../db.ts';
import { redactString } from '../sanitise.ts';
import { signPayload } from './sign.ts';
import { sendEscalationFallback } from './email-fallback.ts';

export type DispatchOutcome = { status: 'sent' | 'fallback_sent' | 'retry' | 'failed' | 'skipped'; booked: boolean;
  appointmentAt: string | null; reason?: string };
export const MAX_ATTEMPTS = 3;

type Claimed = { id: string; escalation_id: string; slot_key: string; attempts: number };
type Esc = { id: string; escalation_ref: string; category: string; reason: string; user_name: string; user_email: string };

/**
 * Sends one outbox row, exactly once. The claim is a single conditional
 * UPDATE, so two workers (the tool and the sweeper) can never both send it.
 * It never throws: every failure is stored on the row for the sweeper and the
 * console, and the caller gets an outcome it can tell the customer about.
 */
export async function dispatchNotification(notificationId: string, opts: { dryRun?: boolean; fault?: 'n8n_down' | null } = {}): Promise<DispatchOutcome> {
  let n: Claimed | null = null;
  try {
    n = await one<Claimed>(`update public.notifications set status = 'sending', attempts = attempts + 1, claimed_at = now()
      where id = $1 and status in ('pending', 'retry') returning id, escalation_id, slot_key, attempts`, [notificationId]);
    if (!n) return { status: 'skipped', booked: false, appointmentAt: null };
    const e = (await one<Esc>(`select id, escalation_ref, category, reason, user_name, user_email from public.escalations where id = $1`, [n.escalation_id]))!;
    const slot = n.slot_key === 'none' ? null : n.slot_key;

    if (opts.dryRun) {
      await query(`update public.notifications set status = 'sent', sent_at = now() where id = $1`, [n.id]);
      await query(`update public.escalations set notify_status = 'sent', updated_at = now(),
        booking_status = case when $2::timestamptz is null then booking_status else 'dry_run' end,
        call_booked = ($2::timestamptz is not null), appointment_at = coalesce($2::timestamptz, appointment_at) where id = $1`, [e.id, slot]);
      return { status: 'sent', booked: !!slot, appointmentAt: slot };
    }

    const body = JSON.stringify({ escalation_ref: e.escalation_ref, idempotency_key: `${e.escalation_ref}:${n.slot_key}`,
      category: e.category, reason: e.reason, user_name: e.user_name, user_email: e.user_email, requested_slot_utc: slot,
      slot_minutes: config.hours.slotMinutes, console_url: `${config.web.baseUrl}/console/escalations/${e.id}` });
    const ts = Math.floor(Date.now() / 1000);
    const url = opts.fault === 'n8n_down' ? 'http://127.0.0.1:9/' : config.escalation.n8nUrl;
    let answer: { booked?: boolean; event_id?: string; appointment_at?: string; reason?: string } | null = null;
    let laneError = '';
    try {
      const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(config.escalation.timeoutMs),
        headers: { 'content-type': 'application/json', 'x-relaypay-timestamp': String(ts),
          'x-relaypay-signature': signPayload(config.escalation.n8nSecret, body, ts) } });
      if (res.ok) answer = await res.json() as any;
      else laneError = `n8n returned ${res.status}`;
    } catch (err) { laneError = `n8n unreachable: ${(err as Error).message}`; }

    if (answer) {
      await query(`update public.notifications set status = 'sent', sent_at = now(), last_error = null where id = $1`, [n.id]);
      const booked = !!slot && answer.booked === true;
      const bookingStatus = !slot ? null : booked ? 'booked' : answer.reason === 'slot_taken' ? 'slot_unavailable' : 'failed';
      await query(`update public.escalations set notify_status = 'sent', updated_at = now(),
          booking_status = coalesce($2, booking_status), call_booked = $3,
          appointment_at = case when $3 then coalesce($4::timestamptz, $5::timestamptz) else appointment_at end,
          calendar_event_id = coalesce($6, calendar_event_id)
        where id = $1`, [e.id, bookingStatus, booked, answer.appointment_at ?? null, slot, answer.event_id ?? null]);
      return { status: 'sent', booked, appointmentAt: booked ? (answer.appointment_at ?? slot) : null, reason: answer.reason };
    }

    const mail = await sendEscalationFallback({ ref: e.escalation_ref, category: e.category, reason: e.reason, userName: e.user_name,
      userEmail: e.user_email, requestedSlot: slot, consoleUrl: `${config.web.baseUrl}/console/escalations/${e.id}` });
    if (mail.ok) {
      await query(`update public.notifications set status = 'fallback_sent', sent_at = now(), last_error = $2 where id = $1`, [n.id, redactString(laneError)]);
      await query(`update public.escalations set notify_status = 'fallback_sent', call_booked = false, updated_at = now(),
        booking_status = case when $2::text is null then booking_status else 'failed' end where id = $1`, [e.id, slot]);
      return { status: 'fallback_sent', booked: false, appointmentAt: null, reason: laneError };
    }
    const final = n.attempts >= MAX_ATTEMPTS;
    await query(`update public.notifications set status = $2, last_error = $3 where id = $1`,
      [n.id, final ? 'failed' : 'retry', redactString(`${laneError}; ${mail.error}`).slice(0, 500)]);
    await query(`update public.escalations set updated_at = now(), notify_status = case when $2 then 'failed' else notify_status end,
      booking_status = case when $3::text is null then booking_status else 'failed' end where id = $1`, [e.id, final, slot]);
    return { status: final ? 'failed' : 'retry', booked: false, appointmentAt: null, reason: `${laneError}; ${mail.error}` };
  } catch (err) {
    const msg = redactString((err as Error).message).slice(0, 500);
    if (n) await query(`update public.notifications set status = case when attempts >= $3 then 'failed' else 'retry' end, last_error = $2 where id = $1`,
      [n.id, msg, MAX_ATTEMPTS]).catch(() => undefined);
    return { status: 'retry', booked: false, appointmentAt: null, reason: msg };
  }
}
