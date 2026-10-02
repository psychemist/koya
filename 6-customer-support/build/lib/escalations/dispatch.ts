import { config } from '../config.ts';
import { one, query } from '../db.ts';
import { redactString } from '../sanitise.ts';
import { bookCallback } from './cal.ts';
import { postToDiscord } from './discord.ts';
import { sendSupportEmail } from './support-email.ts';
import type { Alert, BookingOutcome } from './alert.ts';

export type DispatchOutcome = { status: 'sent' | 'fallback_sent' | 'retry' | 'failed' | 'skipped'; booked: boolean;
  appointmentAt: string | null; reason?: string };
export const MAX_ATTEMPTS = 3;

type Claimed = { id: string; escalation_id: string; slot_key: string; attempts: number; booking_result: 'booked' | 'slot_taken' | 'failed' | null;
  booking_uid: string | null; discord_status: string | null; email_sent_at: Date | null };
type Esc = { id: string; escalation_ref: string; category: string; reason: string; user_name: string; user_email: string; caller_timezone: string | null };

/**
 * Sends one outbox row, exactly once. The claim is a single conditional
 * UPDATE, so two workers (the tool and the sweeper) can never both send it.
 *
 * Three steps: book the callback on Cal.com, then post to Discord and email
 * the support inbox together. Each step's result is stored on the row, so a
 * retry only redoes what did not happen. The email is the alert of record and
 * is retried; Discord is best effort and tried once.
 *
 * It never throws: every failure is stored on the row for the sweeper and the
 * console, and the caller gets an outcome it can tell the customer about.
 */
export async function dispatchNotification(notificationId: string, opts: { dryRun?: boolean; fault?: 'calendar_down' | null } = {}): Promise<DispatchOutcome> {
  let n: Claimed | null = null;
  try {
    n = await one<Claimed>(`update public.notifications set status = 'sending', attempts = attempts + 1, claimed_at = now()
      where id = $1 and status in ('pending', 'retry')
      returning id, escalation_id, slot_key, attempts, booking_result, booking_uid, discord_status, email_sent_at`, [notificationId]);
    if (!n) return { status: 'skipped', booked: false, appointmentAt: null };
    const e = (await one<Esc>(`select id, escalation_ref, category, reason, user_name, user_email, caller_timezone
      from public.escalations where id = $1`, [n.escalation_id]))!;
    const slot = n.slot_key === 'none' ? null : n.slot_key;

    if (opts.dryRun) {
      // Eval conversations reach no real service. A calendar_down fault still fails the booking, so eval row 23
      // tests what the caller is told when the calendar is down, without emailing the real inbox on every run.
      const failBooking = !!slot && opts.fault === 'calendar_down';
      await query(`update public.notifications set status = 'sent', sent_at = now(), booking_result = $2 where id = $1`,
        [n.id, slot ? (failBooking ? 'failed' : 'booked') : null]);
      await query(`update public.escalations set notify_status = 'sent', updated_at = now(),
        booking_status = case when $2::timestamptz is null then booking_status when $3 then 'failed' else 'dry_run' end,
        call_booked = ($2::timestamptz is not null and not $3),
        appointment_at = case when $3 then appointment_at else coalesce($2::timestamptz, appointment_at) end where id = $1`, [e.id, slot, failBooking]);
      return { status: 'sent', booked: !!slot && !failBooking, appointmentAt: failBooking ? null : slot };
    }

    // 1. The booking, unless an earlier attempt settled it. A failed booking is tried again: Cal.com may be back.
    let booking = n.booking_result, uid = n.booking_uid, bookError = '';
    if (slot && booking !== 'booked' && booking !== 'slot_taken') {
      const baseUrl = opts.fault === 'calendar_down' ? 'http://127.0.0.1:9/' : config.escalation.calApiUrl;
      const r = await bookCallback({ start: slot, name: e.user_name, email: e.user_email, timeZone: e.caller_timezone ?? 'UTC',
        ref: e.escalation_ref, key: `${e.escalation_ref}:${n.slot_key}` }, { baseUrl, lookFirst: n.attempts > 1 });
      booking = r.result;
      if (r.result === 'booked') uid = r.uid;
      if (r.result === 'failed') bookError = r.error;
      await query(`update public.notifications set booking_result = $2, booking_uid = $3 where id = $1`, [n.id, booking, uid]);
    }
    const booked = booking === 'booked';
    if (slot) await query(`update public.escalations set updated_at = now(), booking_status = $2, call_booked = $3,
        appointment_at = case when $3 then $4::timestamptz else appointment_at end, calendar_event_id = coalesce($5, calendar_event_id)
      where id = $1`, [e.id, booked ? 'booked' : booking === 'slot_taken' ? 'slot_unavailable' : 'failed', booked, slot, uid]);

    // 2. Tell the team. Discord once, best effort; the email until it is delivered.
    const outcome: BookingOutcome = !slot ? 'no_slot' : booked ? 'booked' : booking === 'slot_taken' ? 'slot_taken' : 'booking_failed';
    const alert: Alert = { ref: e.escalation_ref, category: e.category, reason: e.reason, userName: e.user_name, userEmail: e.user_email,
      requestedSlot: slot, consoleUrl: `${config.web.baseUrl}/console/escalations/${e.id}`, outcome };
    const [discord, mail] = await Promise.all([
      n.discord_status ?? postToDiscord(alert),
      n.email_sent_at ? { ok: true as const } : sendSupportEmail(alert),
    ]);
    const errors = [bookError, discord === 'failed' ? 'discord post failed' : '', mail.ok ? '' : mail.error].filter(Boolean).join('; ');
    const lastError = errors ? redactString(errors).slice(0, 500) : null;
    await query(`update public.notifications set discord_status = $2, email_sent_at = case when $3 then coalesce(email_sent_at, now()) else email_sent_at end,
      last_error = $4 where id = $1`, [n.id, discord, mail.ok, lastError]);
    const result = { booked, appointmentAt: booked ? slot : null, ...(errors ? { reason: errors } : {}) };

    if (mail.ok) {
      // fallback_sent: the team knows, but has to arrange the time by hand.
      const status = outcome === 'booking_failed' ? 'fallback_sent' : 'sent';
      await query(`update public.notifications set status = $2, sent_at = now() where id = $1`, [n.id, status]);
      await query(`update public.escalations set notify_status = $2, updated_at = now() where id = $1`, [e.id, status]);
      return { status, ...result };
    }
    const final = n.attempts >= MAX_ATTEMPTS;
    await query(`update public.notifications set status = $2 where id = $1`, [n.id, final ? 'failed' : 'retry']);
    if (final) await query(`update public.escalations set notify_status = 'failed', updated_at = now() where id = $1`, [e.id]);
    return { status: final ? 'failed' : 'retry', ...result };
  } catch (err) {
    const msg = redactString((err as Error).message).slice(0, 500);
    if (n) await query(`update public.notifications set status = case when attempts >= $3 then 'failed' else 'retry' end, last_error = $2 where id = $1`,
      [n.id, msg, MAX_ATTEMPTS]).catch(() => undefined);
    return { status: 'retry', booked: false, appointmentAt: null, reason: msg };
  }
}
