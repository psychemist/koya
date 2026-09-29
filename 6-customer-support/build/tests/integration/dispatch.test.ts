import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { dispatchNotification } from '../../lib/escalations/dispatch.ts';
import { sweepNotifications } from '../../mcp/sweeper.ts';
import { startStub } from '../fakes/http-stub.ts';
import { lanes, useEscalationStubs, esc } from '../fakes/escalation-fixtures.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

useEscalationStubs();

test('row 23: n8n answering 502 sends the Resend fallback, marks the booking failed, and tells the truth', { skip: skipWithoutDatabase }, async () => {
  const down = await startStub(async () => ({ status: 502, json: { error: 'gmail refused' } }));
  process.env.N8N_ESCALATION_URL = down.url;
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T15:00:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status], [false, 'failed']);
  assert.match(r.follow_up_summary, /follow up by email to confirm a time/);
  const [row] = await query('select notify_status from public.escalations where conversation_id=$1', [c.id]);
  assert.equal(row.notify_status, 'fallback_sent');
  const mail = lanes.resend.calls.at(-1)!;
  assert.deepEqual(mail.body.to, ['support@example.com']);
  assert.match(mail.body.subject, /^\[RelayPay escalation\] RP-E-\d{6} account: callback not booked$/);
  assert.equal(mail.headers.authorization, 'Bearer re_test');
  process.env.N8N_ESCALATION_URL = lanes.n8n.url;
  await down.close(); await dropConversation(c.id);
});

test('with both lanes down, the row is left for retry and the sweeper retries it, at most three times', { skip: skipWithoutDatabase }, async () => {
  const n8nDown = await startStub(async () => ({ status: 500, json: {} }));
  const resendDown = await startStub(async () => ({ status: 500, json: {} }));
  Object.assign(process.env, { N8N_ESCALATION_URL: n8nDown.url, RESEND_API_URL: resendDown.url });
  const c = await newConversation({ channel: 'voice_web' });
  await esc(c.id, {});                                   // no time: alert-only row, slot_key 'none'
  const sel = () => query<{ status: string; attempts: number }>(
    `select n.status, n.attempts from public.notifications n join public.escalations e on e.id = n.escalation_id
     where e.conversation_id = $1`, [c.id]).then((r) => r[0]);
  assert.deepEqual(await sel(), { status: 'retry', attempts: 1 });
  const later = (min: number) => new Date(Date.now() + min * 60_000);
  await sweepNotifications(later(2));
  assert.deepEqual(await sel(), { status: 'retry', attempts: 2 });
  await sweepNotifications(later(4));
  assert.deepEqual(await sel(), { status: 'failed', attempts: 3 });
  await sweepNotifications(later(6));
  assert.deepEqual(await sel(), { status: 'failed', attempts: 3 });
  const [e] = await query('select notify_status from public.escalations where conversation_id = $1', [c.id]);
  assert.equal(e.notify_status, 'failed');
  Object.assign(process.env, { N8N_ESCALATION_URL: lanes.n8n.url, RESEND_API_URL: lanes.resend.url });
  await n8nDown.close(); await resendDown.close(); await dropConversation(c.id);
});

test('a notification already claimed by another worker is skipped, not sent twice', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const [e] = await query(`insert into public.escalations (conversation_id, user_name, user_email, category, reason)
    values ($1,'Efua','efua@accrastack.example','account','claimed elsewhere') returning id`, [c.id]);
  const [n] = await query(`insert into public.notifications (escalation_id, slot_key, status, attempts, claimed_at)
    values ($1,'none','sending',1,now()) returning id`, [e.id]);
  const before = lanes.n8n.calls.length;
  assert.equal((await dispatchNotification(n.id)).status, 'skipped');
  assert.equal(lanes.n8n.calls.length, before);
  await dropConversation(c.id);
});

test('a slot n8n reports as taken leaves the escalation open, unbooked, with other times to offer', { skip: skipWithoutDatabase }, async () => {
  const busy = await startStub(async () => ({ status: 200, json: { booked: false, reason: 'slot_taken' } }));
  process.env.N8N_ESCALATION_URL = busy.url;
  const c = await newConversation({ channel: 'voice_web' });
  const r = await esc(c.id, { preferred_time: '2026-10-06T16:00:00Z' });
  assert.deepEqual([r.call_booked, r.booking_status, r.next_slots.length], [false, 'slot_unavailable', 3]);
  assert.match(r.follow_up_summary, /just been taken/);
  const [row] = await query('select notify_status from public.escalations where conversation_id=$1', [c.id]);
  assert.equal(row.notify_status, 'sent');
  process.env.N8N_ESCALATION_URL = lanes.n8n.url;
  await busy.close(); await dropConversation(c.id);
});

test('a crash between claim and send is recovered by the sweeper once the claim is stale', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ channel: 'voice_web' });
  const [e] = await query(`insert into public.escalations (conversation_id, user_name, user_email, category, reason)
    values ($1,'Efua','efua@accrastack.example','account','worker died mid-send') returning id`, [c.id]);
  await query(`insert into public.notifications (escalation_id, slot_key, status, attempts, claimed_at)
    values ($1,'none','sending',1,now())`, [e.id]);
  const before = lanes.n8n.calls.length;
  await sweepNotifications(new Date(Date.now() + 2 * 60_000));
  assert.equal(lanes.n8n.calls.length - before, 1);
  const [n] = await query('select status, attempts from public.notifications where escalation_id = $1', [e.id]);
  assert.deepEqual(n, { status: 'sent', attempts: 2 });
  await dropConversation(c.id);
});
