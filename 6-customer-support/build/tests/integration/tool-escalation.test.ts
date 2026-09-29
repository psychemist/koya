import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { signPayload } from '../../lib/escalations/sign.ts';
import { lanes, useEscalationStubs, esc } from '../fakes/escalation-fixtures.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

useEscalationStubs();

test('scenario 7: an escalation is stored with the normalised email, booked, and the team is notified once', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T14:00:00Z', caller_timezone: 'Africa/Lagos' });
  assert.match(r.escalation_id, /^RP-E-\d{6}$/);
  assert.deepEqual([r.call_booked, r.booking_status, r.appointment_time_utc], [true, 'booked', '2026-10-06T14:00:00.000Z']);
  assert.match(r.follow_up_summary, /Tuesday 6 October at 14:00 UTC, which is 15:00 in Lagos/);
  const [row] = await query('select user_email, notify_status, calendar_event_id from public.escalations where conversation_id=$1', [c.id]);
  assert.deepEqual(row, { user_email: 'efua@accrastack.example', notify_status: 'sent', calendar_event_id: 'evt_1' });
  assert.equal(lanes.n8n.calls.length, 1);
  await dropConversation(c.id);
});

test('the n8n request is signed, and the signature verifies', { skip: skipWithoutDatabase }, async () => {
  const last = lanes.n8n.calls.at(-1)!;
  assert.equal(last.headers['x-relaypay-signature'], signPayload('s', last.raw, Number(last.headers['x-relaypay-timestamp'])));
  assert.match(last.body.idempotency_key, /^RP-E-\d{6}:2026-10-06T14:00:00\.000Z$/);
});

test('the follow-up never promises the customer an email the system does not send', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-08T09:30:00Z' });
  assert.doesNotMatch(r.follow_up_summary, /confirmation/i);
  await dropConversation(c.id);
});

test('the same request twice is one escalation, one calendar event', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const before = lanes.n8n.calls.length;
  const a = await esc(c.id, { preferred_time: '2026-10-06T14:30:00Z' });
  const b = await esc(c.id, { preferred_time: '2026-10-06T14:30:00Z' });
  assert.equal(a.escalation_id, b.escalation_id);
  assert.equal(lanes.n8n.calls.length - before, 1);
  await dropConversation(c.id);
});

test('row 21: Sunday 03:00 still creates the escalation, books nothing, and offers three valid times', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-11T03:00:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status, r.next_slots.length, r.time_issue], [false, 'not_requested', 3, 'OUTSIDE_HOURS']);
  const [{ n }] = await query('select count(*) n from public.escalations where conversation_id=$1', [c.id]);
  assert.equal(Number(n), 1);
  await dropConversation(c.id);
});

test('a later call with a valid time completes the same escalation and books it', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const a = await esc(c.id, { preferred_time: '2026-10-11T03:00:00Z' });
  const b = await esc(c.id, { preferred_time: '2026-10-07T11:00:00Z' });
  assert.equal(a.escalation_id, b.escalation_id);
  assert.deepEqual([b.call_booked, b.booking_status], [true, 'booked']);
  await dropConversation(c.id);
});

test('Review Focus 2: a time without an offset is not booked', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T14:00:00' });
  assert.deepEqual([r.call_booked, r.time_issue, r.next_slots.length], [false, 'TIME_NEEDS_OFFSET', 3]);
  await dropConversation(c.id);
});

test('Review Focus 1: an email that cannot be normalised is refused, asking to spell it', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  await assert.rejects(() => esc(c.id, { user_email: 'efua accrastack' }), (e: any) => e.code === 'INVALID_INPUT' && /spell/.test(e.message));
  await dropConversation(c.id);
});

test('an eval conversation never reaches n8n: booking is dry_run', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'eval' });
  const before = lanes.n8n.calls.length;
  const r = await esc(c.id, { preferred_time: '2026-10-07T10:00:00Z' });
  assert.deepEqual([r.booking_status, lanes.n8n.calls.length - before], ['dry_run', 0]);
  await dropConversation(c.id);
});

test('a ticket reference links the ticket, and an unverified customer id is not attached', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'eval' });
  const [t] = await query(`insert into public.support_tickets (conversation_id, category, priority, summary, dedupe_key)
    values ($1, 'account', 'high', 'Restricted account needs a specialist.', $1::uuid::text || ':account') returning ticket_ref`, [c.id]);
  await esc(c.id, { ticket_id: t.ticket_ref, customer_id: 'CUS-1003' });
  const [row] = await query(`select e.customer_id, s.ticket_ref from public.escalations e left join public.support_tickets s on s.id = e.ticket_id
    where e.conversation_id = $1`, [c.id]);
  assert.deepEqual(row, { customer_id: null, ticket_ref: t.ticket_ref });
  await dropConversation(c.id);
});
