import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { AGENT_INTERNAL_TOKEN: 'internal-test' });
const { issueCallerCookie, readCallerCookie, issueCallToken, readCallToken, cookieFrom } = await import('../../lib/caller.ts');
const { callerLine, frameCallerText } = await import('../../agent/turn.ts');

const amara = { mode: 'customer' as const, customerId: 'CUS-1001' };

test('a signed caller reads back as itself, for a customer and for a guest', () => {
  assert.deepEqual(readCallerCookie(issueCallerCookie(amara)), amara);
  assert.deepEqual(readCallerCookie(issueCallerCookie({ mode: 'guest' })), { mode: 'guest' });
});

test('changing the customer ID in a cookie breaks the signature', () => {
  const t = issueCallerCookie(amara).replace('CUS-1001', 'CUS-1002');
  assert.equal(readCallerCookie(t), null);
});

test('a guest cookie cannot be edited into a customer one', () => {
  const t = issueCallerCookie({ mode: 'guest' }).replace(/^guest\.-/, 'customer.CUS-1001');
  assert.equal(readCallerCookie(t), null);
});

test('a cookie is not a call token and a call token is not a cookie', () => {
  assert.equal(readCallToken(issueCallerCookie(amara)), null);
  assert.equal(readCallerCookie(issueCallToken(amara)), null);
  assert.deepEqual(readCallToken(issueCallToken(amara)), amara);
});

test('a call token lasts ten minutes; a cookie lasts twelve hours', () => {
  const t0 = Date.parse('2026-10-05T09:00:00Z');
  assert.ok(readCallToken(issueCallToken(amara, t0), t0 + 9 * 60_000));
  assert.equal(readCallToken(issueCallToken(amara, t0), t0 + 11 * 60_000), null);
  assert.ok(readCallerCookie(issueCallerCookie(amara, t0), t0 + 11 * 3_600_000));
  assert.equal(readCallerCookie(issueCallerCookie(amara, t0), t0 + 13 * 3_600_000), null);
});

test('garbage is no caller', () => {
  for (const t of [undefined, null, 42, '', 'a.b.c', 'customer.CUS-1001.9999999999.sig']) assert.equal(readCallerCookie(t), null);
});

test('cookieFrom picks one cookie out of a header', () => {
  assert.equal(cookieFrom('a=1; rp_caller=x.y=z; b=2', 'rp_caller'), 'x.y=z');
  assert.equal(cookieFrom(null, 'rp_caller'), null);
});

test('the turn tells the model a signed-in caller is verified, and a guest gets the knowledge base only', () => {
  const account = { customer_id: 'CUS-1001', contact_name: 'Amara Okafor', company_name: 'LagosLedger', plan: 'Growth' };
  assert.match(callerLine({ mode: 'customer', account })!, /signed in .* Amara Okafor of LagosLedger, customer ID CUS-1001.*already verified/);
  assert.match(callerLine({ mode: 'guest' })!, /guest.*Knowledge base answers only/);
  assert.equal(callerLine(null), null);
  const framed = frameCallerText('hi', new Date('2026-10-05T09:00:00Z'), undefined, 'chat', null, { mode: 'guest' });
  assert.match(framed, /\[Channel: web chat\]\n\[Caller: guest/);
  assert.doesNotMatch(frameCallerText('hi', new Date(), undefined, 'voice', null, null), /\[Caller:/);
});

test('a signed-in caller line carries their open requests, so the agent can answer about a case without a lookup', () => {
  const account = { customer_id: 'CUS-1001', contact_name: 'Amara Okafor', company_name: 'LagosLedger', plan: 'Growth',
    open: [{ ref: 'RP-E-000341', kind: 'escalation' as const, category: 'dispute', status: 'open', callback_at: '2026-10-05T11:00:00Z' },
           { ref: 'RP-T-000120', kind: 'ticket' as const, category: 'payout', status: 'in_progress', callback_at: null }] };
  const line = callerLine({ mode: 'customer', account })!;
  assert.match(line, /Open requests: RP-E-000341 \(specialist case, dispute, open, callback booked for 2026-10-05T11:00:00.000Z\); RP-T-000120 \(ticket, payout, in progress\)/);
  assert.match(callerLine({ mode: 'customer', account: { ...account, open: null } })!, /Open requests: none/);
});
