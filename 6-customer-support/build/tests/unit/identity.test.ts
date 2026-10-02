import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCustomer, normalizeSpokenEmail } from '../../lib/identity.ts';

const rows = [
  { customer_id: 'CUS-1001', company_name: 'LagosLedger', contact_name: 'Amara Okafor', contact_email: 'amara@lagosledger.example' },
  { customer_id: 'CUS-1002', company_name: 'NairobiOps', contact_name: 'Daniel Mwangi', contact_email: 'daniel@nairobiops.example' },
] as any[];

test('brief scenario 3: a first name and a company are two identifiers', () => {
  const m = matchCustomer(rows, { contact_name: 'Amara', company_name: 'Lagos Ledger' });
  assert.equal(m.status, 'matched');
  assert.equal((m as any).customer.customer_id, 'CUS-1001');
});

test('one identifier is never enough', () => {
  assert.equal(matchCustomer(rows, { company_name: 'LagosLedger' }).status, 'need_second_identifier');
});

test('a wrong pairing is no_match, and the result does not say which part was wrong', () => {
  assert.deepEqual(matchCustomer(rows, { contact_name: 'Daniel', company_name: 'LagosLedger' }), { status: 'no_match' });
});

test('every provided identifier must agree: two right and one contradicting is no_match', () => {
  assert.equal(matchCustomer(rows, { contact_name: 'Amara', email: 'amara@lagosledger.example', company_name: 'NairobiOps' }).status, 'no_match');
});

test('whitespace-only identifiers do not count toward two', () => {
  assert.equal(matchCustomer(rows, { contact_name: 'Amara', company_name: '   ' }).status, 'need_second_identifier');
});

test('a customer id said aloud still matches', () => {
  assert.equal(matchCustomer(rows, { customer_id: 'c u s one zero zero one', contact_name: 'Amara Okafor' }).status, 'matched');
});

test('Review Focus 1: a spoken email is normalised', () => {
  assert.equal(normalizeSpokenEmail('amara at lagos ledger dot example'), 'amara@lagosledger.example');
  assert.equal(normalizeSpokenEmail('Efua.Mensah@AccraStack.example'), 'efua.mensah@accrastack.example');
  assert.equal(normalizeSpokenEmail('john underscore doe at mail dot co dot uk'), 'john_doe@mail.co.uk');
});

test('Review Focus 1: something that is not an email stays null', () => {
  assert.equal(normalizeSpokenEmail('amara lagos ledger'), null);
  assert.equal(normalizeSpokenEmail('amara at lagosledger'), null);
});

test('a full name misheard by one letter still matches, with a second identifier that agrees', () => {
  assert.equal(matchCustomer(rows, { contact_name: 'Amara Okafo', email: 'amara@lagosledger.example' }).status, 'matched');
  assert.equal(matchCustomer(rows, { contact_name: 'Amara Okafo', company_name: 'Lagos Ledger' }).status, 'matched');
  assert.equal(matchCustomer(rows, { contact_name: 'Amara Okafor', company_name: 'Lagos Leger' }).status, 'matched');
});

test('the slack is for mishearing, not for another person: a first name stays exact, and a far name is no_match', () => {
  assert.equal(matchCustomer(rows, { contact_name: 'Amaka', company_name: 'LagosLedger' }).status, 'no_match');
  assert.equal(matchCustomer(rows, { contact_name: 'Amara Okeke', company_name: 'LagosLedger' }).status, 'no_match');
  assert.equal(matchCustomer(rows, { contact_name: 'Amara Okafo', company_name: 'NairobiOps' }).status, 'no_match');
});
