import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../lib/db.ts';
import { customerTool } from '../../mcp/tools/lookup-customer.ts';
import { transactionTool } from '../../mcp/tools/lookup-transaction.ts';
import { payoutTool } from '../../mcp/tools/lookup-payout.ts';
import { skipWithoutDatabase, newConversation, dropConversation } from '../helpers.ts';

const cust = async (conv: string, a: object) => (await customerTool.run(a as any, conv)).result as any;
const txn = async (conv: string, id: string) => (await transactionTool.run({ transaction_id: id }, conv)).result as any;

test('scenario 3: Amara from LagosLedger is found, and the call becomes bound to CUS-1001', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await cust(c.id, { contact_name: 'Amara', company_name: 'LagosLedger' });
  assert.deepEqual([r.found, r.customer_id, r.plan, r.escalation_required, r.verification], [true, 'CUS-1001', 'Growth', false, 'two_identifiers']);
  const [row] = await query('select verified_customer_id from public.conversations where id = $1', [c.id]);
  assert.equal(row.verified_customer_id, 'CUS-1001');
  await dropConversation(c.id);
});

test('the specified output fields are all present on a found customer', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await cust(c.id, { contact_name: 'Amara', company_name: 'LagosLedger' });
  for (const k of ['found', 'customer_id', 'company_name', 'plan', 'account_status', 'kyc_status', 'support_notes']) assert.ok(k in r, k);
  assert.ok(!('contact_email' in r), 'the contact email is never returned');
  await dropConversation(c.id);
});

test('row 12: one identifier asks for a second', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.deepEqual((({ found, reason }) => ({ found, reason }))(await cust(c.id, { company_name: 'LagosLedger' })),
    { found: false, reason: 'need_second_identifier' });
  await dropConversation(c.id);
});

test('row 13: a wrong pairing is no_match, and after three failures the call is locked out', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  for (let i = 0; i < 3; i++) assert.equal((await cust(c.id, { contact_name: 'Daniel', company_name: 'LagosLedger' })).reason, 'no_match');
  assert.equal((await cust(c.id, { contact_name: 'Amara', company_name: 'LagosLedger' })).reason, 'too_many_attempts');
  await dropConversation(c.id);
});

test('scenario 5 / AccraStack: a restricted customer comes back with escalation_required', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await cust(c.id, { contact_name: 'Efua', company_name: 'AccraStack' });
  assert.equal(r.escalation_required, true);
  await dropConversation(c.id);
});

test('scenario 4: a reference alone gives status and summary, but withholds the amount', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = await txn(c.id, 'TXN-9001');
  assert.deepEqual([r.found, r.status, r.amount, r.verification], [true, 'processing', null, 'reference_only']);
  assert.match(r.support_summary, /normal expected window/);
  await dropConversation(c.id);
});

test('row 11: a spoken reference is normalised and found', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.equal((await txn(c.id, 't x n nine zero zero one')).transaction_id, 'TXN-9001');
  await dropConversation(c.id);
});

test('a verified owner gets the amount', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ verified_customer_id: 'CUS-1001' });
  const r = await txn(c.id, 'TXN-9001');
  assert.deepEqual([r.amount, r.currency, r.verification], ['2400.00', 'USD', 'customer_verified']);
  await dropConversation(c.id);
});

test('row 14: verified as Amara, a transaction belonging to AccraStack is not found, and existence does not leak', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ verified_customer_id: 'CUS-1001' });
  const r = await txn(c.id, 'TXN-9003');
  assert.deepEqual(r, { found: false, reason: 'not_found', transaction_id: 'TXN-9003' });
  await dropConversation(c.id);
});

test('row 16: an unknown reference is not found, and nothing is guessed', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.deepEqual(await txn(c.id, 'TXN-0000'), { found: false, reason: 'not_found', transaction_id: 'TXN-0000' });
  assert.equal((await txn(c.id, 'the one from last week')).reason, 'unrecognised_reference');
  await dropConversation(c.id);
});

test('scenario 5: PAY-7002 requires review, and the tool says escalate', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  const r = (await payoutTool.run({ payout_id: 'PAY-7002' }, c.id)).result as any;
  assert.deepEqual([r.found, r.status, r.escalation_required, r.recipient_name], [true, 'review required', true, null]);
  for (const k of ['payout_id', 'status', 'scheduled_for', 'failure_reason', 'support_summary']) assert.ok(k in r, k);
  await dropConversation(c.id);
});

test('a payout can be found by its transaction id, and needs one of the two ids', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.equal(((await payoutTool.run({ transaction_id: 'TXN-9004' }, c.id)).result as any).payout_id, 'PAY-7003');
  assert.equal(payoutTool.input.safeParse({}).success, false);
  await dropConversation(c.id);
});

test('the specified transaction fields are all present, dates are plain days, and the type is named', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation({ verified_customer_id: 'CUS-1001' });
  const r = await txn(c.id, 'TXN-9001');
  for (const k of ['found', 'transaction_id', 'customer_id', 'type', 'status', 'amount', 'currency', 'estimated_arrival', 'support_summary']) assert.ok(k in r, k);
  assert.deepEqual([r.type, r.estimated_arrival, r.ticket_recommended], ['outgoing payout', '2026-08-19', false]);
  await dropConversation(c.id);
});

test('a failed or delayed transaction recommends a ticket', { skip: skipWithoutDatabase }, async () => {
  const c = await newConversation();
  assert.equal((await txn(c.id, 'TXN-9005')).ticket_recommended, true);
  assert.equal((await txn(c.id, 'TXN-9004')).ticket_recommended, true);
  await dropConversation(c.id);
});
