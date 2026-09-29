import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedAll } from '../../scripts/seed.ts';
import { query } from '../../lib/db.ts';
import { skipWithoutDatabase } from '../helpers.ts';

const DIR = new URL('../../../assets/seed-data/', import.meta.url).pathname;

test('seeding twice yields the same rows, not double', { skip: skipWithoutDatabase }, async () => {
  const a = await seedAll(DIR);
  const b = await seedAll(DIR);
  assert.deepEqual(a, { customers: 5, transactions: 5, payouts: 3 });
  assert.deepEqual(b, a);
  const [{ n }] = await query<{ n: string }>('select count(*) n from public.customers');
  assert.equal(Number(n), 5);
});

test('an empty estimated_arrival becomes null, never a fake date', { skip: skipWithoutDatabase }, async () => {
  const [row] = await query('select estimated_arrival from public.transactions where transaction_id = $1', ['TXN-9003']);
  assert.equal(row.estimated_arrival, null);
});

test('company and email keys are computed for matching', { skip: skipWithoutDatabase }, async () => {
  const [row] = await query('select company_key, email_key from public.customers where customer_id = $1', ['CUS-1001']);
  assert.deepEqual(row, { company_key: 'lagosledger', email_key: 'amara@lagosledger.example' });
});
