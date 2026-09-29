import { readFile } from 'node:fs/promises';
import { parseCsv } from '../lib/csv.ts';
import { tx } from '../lib/db.ts';

const nul = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());

export async function seedAll(dir: string) {
  const read = async (f: string) => parseCsv(await readFile(`${dir}/${f}`, 'utf8'));
  const [customers, transactions, payouts] = await Promise.all(
    ['customers.csv', 'transactions.csv', 'payouts.csv'].map(read));
  await tx(async (c) => {
    for (const r of customers) await c.query(
      `insert into public.customers (customer_id, company_name, contact_name, contact_email, plan, account_status, region, kyc_status, support_notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (customer_id) do update set company_name=excluded.company_name, contact_name=excluded.contact_name,
         contact_email=excluded.contact_email, plan=excluded.plan, account_status=excluded.account_status,
         region=excluded.region, kyc_status=excluded.kyc_status, support_notes=excluded.support_notes, updated_at=now()`,
      [r.customer_id, r.company_name, r.contact_name, r.contact_email, r.plan, r.account_status, r.region, r.kyc_status, r.support_notes]);
    for (const r of transactions) await c.query(
      `insert into public.transactions (transaction_id, customer_id, transaction_type, amount, currency, destination_country, status, created_at, estimated_arrival, support_summary)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (transaction_id) do update set customer_id=excluded.customer_id, transaction_type=excluded.transaction_type,
         amount=excluded.amount, currency=excluded.currency, destination_country=excluded.destination_country, status=excluded.status,
         created_at=excluded.created_at, estimated_arrival=excluded.estimated_arrival, support_summary=excluded.support_summary, updated_at=now()`,
      [r.transaction_id, r.customer_id, r.transaction_type, r.amount, r.currency, nul(r.destination_country), r.status, r.created_at, nul(r.estimated_arrival), r.support_summary]);
    for (const r of payouts) await c.query(
      `insert into public.payouts (payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (payout_id) do update set transaction_id=excluded.transaction_id, customer_id=excluded.customer_id,
         recipient_name=excluded.recipient_name, amount=excluded.amount, currency=excluded.currency, status=excluded.status,
         scheduled_for=excluded.scheduled_for, failure_reason=excluded.failure_reason, updated_at=now()`,
      [r.payout_id, nul(r.transaction_id), r.customer_id, r.recipient_name, r.amount, r.currency, r.status, nul(r.scheduled_for), nul(r.failure_reason)]);
  });
  return { customers: customers.length, transactions: transactions.length, payouts: payouts.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('../../assets/seed-data/', import.meta.url).pathname;
  console.log(await seedAll(dir));
  process.exit(0);
}
