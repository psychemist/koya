// Stress tests for double booking: concurrent requests, repeated requests, a second conversation for the same
// customer, a move to a taken time, and the same outbox row dispatched at once. Cal.com is a local stub that hands
// out a fresh booking id per booking and records cancels, so "live" means booked and not cancelled.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { one, query } from '../../lib/db.ts';
import { dispatchNotification } from '../../lib/escalations/dispatch.ts';
import { lanes, calFree, healLanes, useEscalationStubs, esc } from '../fakes/escalation-fixtures.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

process.env.ESCALATION_ALERT_HOLD_MS = '0';
useEscalationStubs();

// Every conversation a test makes is dropped after it, pass or fail, so a failing run leaves no open bookings behind.
const made_conversations: string[] = [];
afterEach(async () => { for (const id of made_conversations.splice(0)) await dropConversation(id).catch(() => undefined); });
const conversation = async (channel: 'voice_web' | 'web_text') => { const c = await newConversation({ channel }); made_conversations.push(c.id); return c; };

let seq = 0;
const made: { uid: string; start: string }[] = [];
beforeEach(() => {
  healLanes();
  made.length = 0;
  lanes.cal.calls.length = 0;
  lanes.calAnswers.create = (body: any) => {
    if (body?.start === undefined) return { status: 200, json: { status: 'success', data: { status: 'cancelled' } } };   // a cancel
    const uid = `bk_s${++seq}`;
    made.push({ uid, start: body.start });
    return { status: 201, json: { status: 'success', data: { id: seq, uid, start: body.start } } };
  };
});
const cancelled = () => new Set(lanes.cal.calls.map((c) => c.path.match(/^\/v2\/bookings\/([^/]+)\/cancel$/)?.[1]).filter(Boolean) as string[]);
const live = () => { const gone = cancelled(); return made.filter((b) => !gone.has(b.uid)); };
const slotAt = (i: number) => new Date(Date.parse('2026-10-06T08:00:00Z') + i * 30 * 60_000).toISOString();
const who = () => ({ user_email: `stress-${randomUUID().slice(0, 8)}@accrastack.example` });
const escRow = (conv: string) => one<{ calendar_event_id: string | null; appointment_at: Date | null; requested_slot_at: Date | null; call_booked: boolean }>(
  'select calendar_event_id, appointment_at, requested_slot_at, call_booked from public.escalations where conversation_id = $1', [conv]);

test('eight concurrent requests for different times in one call leave exactly one live booking, the latest request', { skip: skipWithoutDatabase }, async () => {
  const c = await conversation('voice_web');
  const me = who();
  await Promise.all(Array.from({ length: 8 }, (_, i) => esc(c.id, { ...me, preferred_time: slotAt(i) })));
  const still = live(), row = (await escRow(c.id))!;
  assert.equal(still.length, 1, `live bookings: ${JSON.stringify(still)} of ${made.length} made`);
  assert.equal(row.calendar_event_id, still[0].uid);
  assert.equal(row.call_booked, true);
  assert.equal(row.appointment_at!.toISOString(), row.requested_slot_at!.toISOString(), 'the kept booking is the time asked for last');
  assert.equal(new Date(still[0].start).toISOString(), row.appointment_at!.toISOString());
});

test('the same time asked for five times at once books once', { skip: skipWithoutDatabase }, async () => {
  const c = await conversation('voice_web');
  const me = who();
  await Promise.all(Array.from({ length: 5 }, () => esc(c.id, { ...me, preferred_time: slotAt(2) })));
  assert.equal(made.length, 1);
  assert.equal(live().length, 1);
});

test('a second conversation for the same customer does not book a second callback, and names the first', { skip: skipWithoutDatabase }, async () => {
  const me = who();
  const first = await conversation('voice_web');
  const r1 = await esc(first.id, { ...me, preferred_time: slotAt(3) });
  assert.equal(r1.call_booked, true);
  const second = await conversation('web_text');
  const r2 = await esc(second.id, { ...me, preferred_time: slotAt(6) });
  assert.equal(made.length, 1, 'no second Cal.com booking');
  assert.equal(r2.already_booked.escalation_id, r1.escalation_id);
  assert.match(r2.follow_up_summary, /already have a specialist callback booked .* so I have not booked a second one/);
});

test('moving to a time that is taken keeps the callback already booked, and says so', { skip: skipWithoutDatabase }, async () => {
  const c = await conversation('voice_web');
  const me = who();
  await esc(c.id, { ...me, preferred_time: slotAt(4) });
  const taken = slotAt(5);
  lanes.calAnswers.slots = (call) => call.query.get('start') === taken ? { status: 200, json: { status: 'success', data: {} } } : calFree.slots(call);
  const r = await esc(c.id, { ...me, preferred_time: taken });
  const row = (await escRow(c.id))!;
  assert.equal(row.call_booked, true);
  assert.equal(row.appointment_at!.toISOString(), slotAt(4));
  assert.equal(live().length, 1);
  assert.match(r.follow_up_summary, /I could not book that time, so your callback stays booked for/);
});

test('one outbox row dispatched five times at once books once', { skip: skipWithoutDatabase }, async () => {
  const c = await conversation('voice_web');
  const e = (await one<{ id: string }>(`insert into public.escalations (conversation_id, user_name, user_email, category, reason, requested_slot_at)
    values ($1, 'Efua Mensah', $2, 'account', 'Stress test of a dispatched row.', $3) returning id`, [c.id, who().user_email, slotAt(7)]))!;
  const n = (await one<{ id: string }>(`insert into public.notifications (escalation_id, slot_key) values ($1, $2) returning id`, [e.id, slotAt(7)]))!;
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => dispatchNotification(n.id, { dryRun: false, fault: null })));
  assert.equal(made.length, 1);
  assert.equal(outcomes.filter((o) => o.status === 'skipped').length, 4, 'the other four found the row already claimed');
});

test('a time another customer holds is taken: the second customer is offered other times and nothing is booked', { skip: skipWithoutDatabase }, async () => {
  const a = await conversation('voice_web'), b = await conversation('web_text');
  const r1 = await esc(a.id, { ...who(), preferred_time: slotAt(9) });
  assert.equal(r1.call_booked, true);
  const r2 = await esc(b.id, { ...who(), preferred_time: slotAt(9) });
  assert.equal(made.length, 1, 'the second customer never reached Cal.com for a held time');
  assert.equal(r2.call_booked, false);
  assert.ok(Array.isArray(r2.next_slots) && r2.next_slots.length > 0, 'other times are offered');
});

test('two customers racing for the same time leave exactly one live booking, and the loser is cancelled', { skip: skipWithoutDatabase }, async () => {
  const convs = await Promise.all([conversation('voice_web'), conversation('web_text'), conversation('voice_web')]);
  const results = await Promise.all(convs.map((c) => esc(c.id, { ...who(), preferred_time: slotAt(10) })));
  assert.equal(live().length, 1, `live: ${JSON.stringify(live())}, made: ${made.length}`);
  assert.equal(results.filter((r) => r.call_booked).length, 1, 'exactly one customer is told their callback is booked');
  const held = await query(`select count(*)::int as n from public.escalations where appointment_at = $1 and call_booked and booking_status = 'booked' and status <> 'closed'`, [slotAt(10)]);
  assert.equal(held[0].n, 1);
});
