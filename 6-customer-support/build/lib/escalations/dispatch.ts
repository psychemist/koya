import { config } from '../config.ts';
import { one, query } from '../db.ts';
import { redactString } from '../sanitise.ts';
import { bookCallback, cancelCallback } from './cal.ts';
import { postEmailGaveUp, postToDiscord } from './discord.ts';
import { sendSupportEmail } from './support-email.ts';
import type { Alert, BookingOutcome } from './alert.ts';

export type DispatchOutcome = { status: 'sent' | 'fallback_sent' | 'retry' | 'failed' | 'skipped' | 'held'; booked: boolean;
  appointmentAt: string | null; reason?: string };
export const MAX_ATTEMPTS = 3;

type Claimed = { id: string; escalation_id: string; slot_key: string; attempts: number; booking_result: 'booked' | 'slot_taken' | 'failed' | null;
  booking_uid: string | null; discord_status: string | null; email_sent_at: Date | null; alert_after: Date | null; created_at: Date };
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
      returning id, escalation_id, slot_key, attempts, booking_result, booking_uid, discord_status, email_sent_at, alert_after, created_at`, [notificationId]);
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
    // Another customer's open case already holds this time: it is taken, whatever the calendar would say.
    const heldByOther = slot && booking !== 'booked' && booking !== 'slot_taken' ? await one(
      `select 1 from public.escalations where id <> $1 and status <> 'closed' and call_booked and booking_status = 'booked'
         and appointment_at = $2::timestamptz`, [e.id, slot]) : null;
    if (heldByOther) {
      booking = 'slot_taken';
      await query(`update public.notifications set booking_result = 'slot_taken' where id = $1`, [n.id]);
    } else if (slot && booking !== 'booked' && booking !== 'slot_taken') {
      const baseUrl = opts.fault === 'calendar_down' ? 'http://127.0.0.1:9/' : config.escalation.calApiUrl;
      const r = await bookCallback({ start: slot, name: e.user_name, email: e.user_email, timeZone: e.caller_timezone ?? 'UTC',
        ref: e.escalation_ref, key: `${e.escalation_ref}:${n.slot_key}` }, { baseUrl, lookFirst: n.attempts > 1 });
      booking = r.result;
      if (r.result === 'booked') uid = r.uid;
      if (r.result === 'failed') bookError = r.error;
      await query(`update public.notifications set booking_result = $2, booking_uid = $3 where id = $1`, [n.id, booking, uid]);
    }
    // One booked callback per escalation, however many attempts race. The escalation row is locked while the
    // booking is recorded, so a second attempt sees the first one's booking and replaces it rather than missing
    // it. Only a booking for the caller's latest requested time may become the callback; an older attempt that
    // books late is cancelled instead. A move that fails leaves the callback already booked in place.
    const gotOne = booking === 'booked';
    let booked = false;
    if (slot) {
      const swap = () => one<{ old_uid: string | null; conversation_id: string; wins: boolean; had_booking: boolean }>(
        `with prev as (select id, calendar_event_id, call_booked, conversation_id, requested_slot_at
                         from public.escalations where id = $1 for update),
              w as (select prev.*, ($3 and (prev.requested_slot_at is null or prev.requested_slot_at = $4::timestamptz)) as wins from prev)
         update public.escalations e set updated_at = now(),
           booking_status = case when w.wins then 'booked' when w.call_booked then e.booking_status else $2 end,
           call_booked = w.wins or w.call_booked,
           appointment_at = case when w.wins then $4::timestamptz else e.appointment_at end,
           calendar_event_id = case when w.wins then $5 else e.calendar_event_id end
         from w where e.id = w.id
         returning w.calendar_event_id as old_uid, w.conversation_id, w.wins, w.call_booked as had_booking`,
        [e.id, booking === 'slot_taken' ? 'slot_unavailable' : 'failed', gotOne, slot, uid]);
      let r: Awaited<ReturnType<typeof swap>>;
      try { r = await swap(); } catch (err: any) {
        if (err?.code !== '23505') throw err;
        // Another customer's booking for the same time was saved first (escalations_one_booking_per_slot). This
        // booking must not stand: cancel it on Cal.com, and record the slot as taken for this case.
        if (uid) await cancelCallback(uid, `Slot already held by another case (${e.escalation_ref})`,
          { baseUrl: opts.fault === 'calendar_down' ? 'http://127.0.0.1:9/' : config.escalation.calApiUrl });
        booking = 'slot_taken'; uid = null;   // cancelled above, so nothing below may treat it as a live booking
        await query(`update public.notifications set booking_result = 'slot_taken', booking_uid = null where id = $1`, [n.id]);
        await query(`update public.escalations set updated_at = now(),
            booking_status = case when call_booked then booking_status else 'slot_unavailable' end where id = $1`, [e.id]);
        r = null;
      }
      booked = !!r?.wins;
      const note = (summary: string) => query(`insert into public.conversation_events (conversation_id, event_type, source, summary)
        values ($1, 'note', 'system', $2)`, [r!.conversation_id, summary.slice(0, 500)]).catch(() => undefined);
      const calBase = opts.fault === 'calendar_down' ? 'http://127.0.0.1:9/' : config.escalation.calApiUrl;
      if (r?.wins && r.old_uid && r.old_uid !== uid) {
        // A moved callback: the new time is booked, so the booking it replaces is cancelled, or the team sees both.
        const c = await cancelCallback(r.old_uid, `Moved to ${slot} (${e.escalation_ref})`, { baseUrl: calBase });
        await note(c.ok ? `Callback moved to ${slot}; the earlier booking ${r.old_uid} was cancelled.`
          : `Callback moved to ${slot}, but the earlier booking ${r.old_uid} could not be cancelled: ${c.error}`);
      } else if (gotOne && uid && !r?.wins && uid !== r?.old_uid) {
        // This attempt booked a time the caller has since moved away from: it must not stay on the calendar.
        const c = await cancelCallback(uid, `Superseded by a later request (${e.escalation_ref})`, { baseUrl: calBase });
        await note(c.ok ? `A booking for ${slot} was made after the caller asked for another time, and was cancelled.`
          : `A superseded booking for ${slot} (${uid}) could not be cancelled: ${c.error}`);
        await query(`update public.notifications set status = 'superseded' where id = $1`, [n.id]);
        return { status: 'skipped', booked: false, appointmentAt: null, reason: 'superseded by a later request' };
      }
    }

    const outcome: BookingOutcome = !slot ? 'no_slot' : booked ? 'booked' : booking === 'slot_taken' ? 'slot_taken' : 'booking_failed';

    // 2. One alert per escalation. With no time yet, or a taken one, the caller is usually offered other times and the
    //    agent tries again, so this row waits; the newest attempt replaces older waiting rows, and the sweeper sends
    //    whichever is still waiting once the hold ends. A booked or failed outcome is settled, and alerts now.
    const supersedeOlder = () => query(`update public.notifications set status = 'superseded'
      where escalation_id = $1 and id <> $2 and status = 'held' and created_at <= $3`, [e.id, n!.id, n!.created_at]);
    const holdMs = config.escalation.alertHoldMs;
    if ((outcome === 'no_slot' || outcome === 'slot_taken') && holdMs > 0 && !n.alert_after) {
      await supersedeOlder();
      await query(`update public.notifications set status = 'held', attempts = attempts - 1,
        alert_after = now() + make_interval(secs => $2::float8 / 1000) where id = $1`, [n.id, holdMs]);
      return { status: 'held', booked: false, appointmentAt: null };
    }
    await supersedeOlder();

    // 3. Tell the team. Discord once, best effort; the email until it is delivered.
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
    if (final) {
      await query(`update public.escalations set notify_status = 'failed', updated_at = now() where id = $1`, [e.id]);
      // The claim makes this branch run once per row, so the error channel hears about it once.
      await postEmailGaveUp(alert, redactString(mail.error), n.attempts);
    }
    return { status: final ? 'failed' : 'retry', ...result };
  } catch (err) {
    const msg = redactString((err as Error).message).slice(0, 500);
    if (n) await query(`update public.notifications set status = case when attempts >= $3 then 'failed' else 'retry' end, last_error = $2 where id = $1`,
      [n.id, msg, MAX_ATTEMPTS]).catch(() => undefined);
    return { status: 'retry', booked: false, appointmentAt: null, reason: msg };
  }
}
