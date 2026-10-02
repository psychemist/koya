import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bookCallback } from '../../lib/escalations/cal.ts';
import { startStub, type Stub, type StubCall } from '../fakes/http-stub.ts';

type Answer = { status: number; json: unknown };
let cal: Stub;
let slots: (call: StubCall) => Answer, create: (body: any) => Answer, list: (call: StubCall) => Answer;
const free = (call: StubCall): Answer => ({ status: 200, json: { status: 'success', data: { '2026-10-06': [{ start: call.query.get('start') }] } } });
const booked = (body: any): Answer => ({ status: 201, json: { status: 'success', data: { id: 7, uid: 'bk_1', start: body.start } } });
const none = (): Answer => ({ status: 200, json: { status: 'success', data: [] } });

before(async () => {
  cal = await startStub(async (body, call) =>
    call.path === '/v2/slots' ? slots(call) : call.method === 'POST' ? create(body) : list(call));
  Object.assign(process.env, { CAL_API_KEY: 'cal_test', CAL_EVENT_TYPE_ID: '42', ESCALATION_STEP_TIMEOUT_MS: '2000' });
});
after(async () => { await cal.close(); });

const input = { start: '2026-10-06T14:00:00.000Z', name: 'Efua Mensah', email: 'efua@accrastack.example',
  timeZone: 'Africa/Lagos', ref: 'RP-E-000004', key: 'RP-E-000004:2026-10-06T14:00:00.000Z' };
const run = (opts: { lookFirst?: boolean; baseUrl?: string } = {}) => bookCallback(input, { baseUrl: opts.baseUrl ?? cal.url, lookFirst: opts.lookFirst ?? false });
const posts = () => cal.calls.filter((c) => c.method === 'POST');
function reset(s = free, c = booked, l = none) { slots = s; create = c; list = l; cal.calls.length = 0; }

test('a free slot is booked with the key, the event type and the caller timezone', async () => {
  reset();
  assert.deepEqual(await run(), { result: 'booked', uid: 'bk_1' });
  const [check, post] = cal.calls;
  assert.equal(check.path, '/v2/slots');
  assert.deepEqual([check.query.get('eventTypeId'), check.query.get('start'), check.query.get('end')],
    ['42', '2026-10-06T14:00:00.000Z', '2026-10-06T14:30:00.000Z']);
  assert.equal(check.headers['cal-api-version'], '2024-09-04');
  assert.equal(post.path, '/v2/bookings');
  assert.equal(post.headers.authorization, 'Bearer cal_test');
  assert.equal(post.headers['cal-api-version'], '2026-02-25');
  assert.deepEqual(post.body, { start: input.start, eventTypeId: 42,
    attendee: { name: 'Efua Mensah', email: 'efua@accrastack.example', timeZone: 'Africa/Lagos' },
    metadata: { relaypay_ref: 'RP-E-000004', relaypay_key: input.key } });
});

test('a slot Cal.com does not list is taken, and nothing is booked', async () => {
  reset(() => ({ status: 200, json: { status: 'success', data: { '2026-10-06': [{ start: '2026-10-06T14:30:00.000Z' }] } } }));
  assert.deepEqual(await run(), { result: 'slot_taken' });
  assert.equal(posts().length, 0);
});

test('a slot listed in another offset is still the same instant, and is free', async () => {
  reset(() => ({ status: 200, json: { status: 'success', data: { '2026-10-06': [{ start: '2026-10-06T15:00:00.000+01:00' }] } } }));
  assert.equal((await run()).result, 'booked');
});

test('a slot taken between the check and the booking is reported as taken, not as a failure', async () => {
  reset(free, () => ({ status: 400, json: { status: 'error', error: { message: 'User either already has booking at this time or is not available' } } }));
  assert.deepEqual(await run(), { result: 'slot_taken' });
});

test('any other refusal is a failure that carries the reason, and never throws', async () => {
  reset(free, () => ({ status: 500, json: { status: 'error', error: { message: 'internal' } } }));
  const r = await run();
  assert.equal(r.result, 'failed');
  assert.match(r.error!, /cal\.com booking returned 500/);
});

test('Cal.com unreachable is a failure, never a throw', async () => {
  reset();
  const r = await run({ baseUrl: 'http://127.0.0.1:9/' });
  assert.equal(r.result, 'failed');
  assert.match(r.error!, /cal\.com unreachable/);
});

test('a retry finds the booking an earlier attempt made and does not book again', async () => {
  reset(free, booked, () => ({ status: 200, json: { status: 'success', data: [{ uid: 'bk_earlier', start: '2026-10-06T14:00:00.000Z' }] } }));
  assert.deepEqual(await run({ lookFirst: true }), { result: 'booked', uid: 'bk_earlier' });
  const [look] = cal.calls;
  assert.equal(look.headers['cal-api-version'], '2026-05-01');
  assert.deepEqual([look.query.get('attendeeEmail'), look.query.get('eventTypeId')], ['efua@accrastack.example', '42']);
  assert.equal(posts().length, 0);
});

test('a retry that finds a different booking for the customer still books this slot', async () => {
  reset(free, booked, () => ({ status: 200, json: { status: 'success', data: [{ uid: 'bk_other', start: '2026-10-06T15:00:00.000Z' }] } }));
  assert.deepEqual(await run({ lookFirst: true }), { result: 'booked', uid: 'bk_1' });
});

test('a retry that cannot look up earlier bookings fails rather than risk booking twice', async () => {
  reset(free, booked, () => ({ status: 503, json: {} }));
  assert.equal((await run({ lookFirst: true })).result, 'failed');
  assert.equal(posts().length, 0);
});
