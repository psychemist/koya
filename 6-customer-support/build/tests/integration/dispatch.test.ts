import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { dispatchNotification } from '../../lib/escalations/dispatch.ts';
import { sweepNotifications } from '../../mcp/sweeper.ts';
import { lanes, bookings, healLanes, useEscalationStubs, esc } from '../fakes/escalation-fixtures.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

useEscalationStubs();
afterEach(healLanes);

const outbox = (conv: string) => query<{ status: string; attempts: number; booking_result: string | null; discord_status: string | null }>(
  `select n.status, n.attempts, n.booking_result, n.discord_status from public.notifications n
   join public.escalations e on e.id = n.escalation_id where e.conversation_id = $1`, [conv]).then((r) => r[0]);
const later = (min: number) => new Date(Date.now() + min * 60_000);

test('row 23: Cal.com answering 502 books nothing, emails support to arrange a time, and tells the truth', { skip: skipWithoutDatabase }, async () => {
  lanes.calAnswers.slots = () => ({ status: 502, json: {} });
  const [ok, err] = [lanes.discord.calls.length, lanes.discordErrors.calls.length];
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T15:00:00Z' });
  assert.deepEqual([lanes.discord.calls.length - ok, lanes.discordErrors.calls.length - err], [0, 1]);
  assert.match(lanes.discordErrors.calls.at(-1)!.body.content, /The calendar booking failed/);
  assert.deepEqual([r.call_booked, r.booking_status], [false, 'failed']);
  assert.match(r.follow_up_summary, /follow up by email to confirm a time/);
  const [row] = await query('select notify_status from public.escalations where conversation_id=$1', [c.id]);
  assert.equal(row.notify_status, 'fallback_sent');
  const mail = lanes.resend.calls.at(-1)!;
  assert.deepEqual(mail.body.to, ['support@example.com']);
  assert.match(mail.body.subject, /^\[RelayPay escalation\] RP-E-\d{6} account: callback not booked$/);
  assert.match(mail.body.text, /The calendar booking failed/);
  await dropConversation(c.id);
});

test('the calendar_down fault fails the booking without reaching Cal.com', { skip: skipWithoutDatabase }, async () => {
  const before = lanes.cal.calls.length;
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T15:30:00Z' }, 'calendar_down');
  assert.deepEqual([r.call_booked, r.booking_status, lanes.cal.calls.length - before], [false, 'failed', 0]);
  await dropConversation(c.id);
});

test('with the email down, the row is retried by the sweeper at most three times, and Discord is posted once', { skip: skipWithoutDatabase }, async () => {
  lanes.resendStatus = 500;
  const discordBefore = lanes.discord.calls.length, errorsBefore = lanes.discordErrors.calls.length;
  const c = await newConversation({ channel: 'voice_web' });
  await esc(c.id, {});                                   // no time: alert-only row, slot_key 'none'
  assert.deepEqual(await outbox(c.id), { status: 'retry', attempts: 1, booking_result: null, discord_status: 'sent' });
  await sweepNotifications(later(2));
  assert.deepEqual([(await outbox(c.id)).status, (await outbox(c.id)).attempts], ['retry', 2]);
  assert.equal(lanes.discordErrors.calls.length - errorsBefore, 0);
  await sweepNotifications(later(4));
  assert.deepEqual([(await outbox(c.id)).status, (await outbox(c.id)).attempts], ['failed', 3]);
  assert.equal(lanes.discordErrors.calls.length - errorsBefore, 1);
  assert.match(lanes.discordErrors.calls.at(-1)!.body.content, /the support email was not delivered after 3 attempts \(resend returned 500\)/);
  await sweepNotifications(later(6));
  assert.equal((await outbox(c.id)).attempts, 3);
  const [e] = await query('select notify_status from public.escalations where conversation_id = $1', [c.id]);
  assert.equal(e.notify_status, 'failed');
  assert.equal(lanes.discord.calls.length - discordBefore, 1);
  assert.equal(lanes.discordErrors.calls.length - errorsBefore, 1);
  await dropConversation(c.id);
});

test('a callback booked before the email failed is not booked again on retry, and stays booked', { skip: skipWithoutDatabase }, async () => {
  lanes.resendStatus = 500;
  const c = await newConversation({ channel: 'voice_web' });
  const before = bookings().length;
  const r = await esc(c.id, { preferred_time: '2026-10-07T09:00:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status], [true, 'booked']);
  lanes.resendStatus = 200;
  await sweepNotifications(later(2));
  assert.deepEqual(await outbox(c.id), { status: 'sent', attempts: 2, booking_result: 'booked', discord_status: 'sent' });
  assert.equal(bookings().length - before, 1);
  const [e] = await query('select call_booked, calendar_event_id, notify_status from public.escalations where conversation_id = $1', [c.id]);
  assert.deepEqual(e, { call_booked: true, calendar_event_id: 'bk_1', notify_status: 'sent' });
  await dropConversation(c.id);
});

test('Discord down is best effort: the escalation is still sent, and Discord is not retried', { skip: skipWithoutDatabase }, async () => {
  lanes.discordStatus = 500;
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-07T09:30:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status], [true, 'booked']);
  assert.deepEqual(await outbox(c.id), { status: 'sent', attempts: 1, booking_result: 'booked', discord_status: 'failed' });
  const [e] = await query('select notify_status from public.escalations where conversation_id = $1', [c.id]);
  assert.equal(e.notify_status, 'sent');
  await dropConversation(c.id);
});

test('a notification already claimed by another worker is skipped, not sent twice', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const [e] = await query(`insert into public.escalations (conversation_id, user_name, user_email, category, reason)
    values ($1,'Efua','efua@accrastack.example','account','claimed elsewhere') returning id`, [c.id]);
  const [n] = await query(`insert into public.notifications (escalation_id, slot_key, status, attempts, claimed_at)
    values ($1,'none','sending',1,now()) returning id`, [e.id]);
  const before = lanes.resend.calls.length;
  assert.equal((await dispatchNotification(n.id)).status, 'skipped');
  assert.equal(lanes.resend.calls.length, before);
  await dropConversation(c.id);
});

test('a slot Cal.com reports as taken leaves the escalation open, unbooked, with other times to offer', { skip: skipWithoutDatabase }, async () => {
  lanes.calAnswers.slots = () => ({ status: 200, json: { status: 'success', data: {} } });
  const before = bookings().length;
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T16:00:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status, r.next_slots.length], [false, 'slot_unavailable', 3]);
  assert.match(r.follow_up_summary, /just been taken/);
  assert.equal(bookings().length - before, 0);
  const [row] = await query('select notify_status from public.escalations where conversation_id=$1', [c.id]);
  assert.equal(row.notify_status, 'sent');
  assert.match(lanes.resend.calls.at(-1)!.body.text, /was taken, so no callback is booked/);
  await dropConversation(c.id);
});

test('a crash between claim and send is recovered by the sweeper once the claim is stale', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const [e] = await query(`insert into public.escalations (conversation_id, user_name, user_email, category, reason)
    values ($1,'Efua','efua@accrastack.example','account','worker died mid-send') returning id`, [c.id]);
  await query(`insert into public.notifications (escalation_id, slot_key, status, attempts, claimed_at)
    values ($1,'none','sending',1,now())`, [e.id]);
  const before = lanes.resend.calls.length;
  await sweepNotifications(later(2));
  assert.equal(lanes.resend.calls.length - before, 1);
  const [n] = await query('select status, attempts from public.notifications where escalation_id = $1', [e.id]);
  assert.deepEqual(n, { status: 'sent', attempts: 2 });
  await dropConversation(c.id);
});
