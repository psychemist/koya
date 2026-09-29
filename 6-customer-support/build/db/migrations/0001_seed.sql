-- ============================================================
-- RelayPay seed tables. Ids are the business references callers say
-- aloud, so they are the primary keys and are format-checked.
-- ============================================================
create extension if not exists pgcrypto;

create table if not exists public.customers (
  customer_id    text primary key check (customer_id ~ '^CUS-[0-9]{4}$'),
  company_name   text not null,
  contact_name   text not null,
  contact_email  text not null,
  plan           text not null check (plan in ('Starter','Growth','Scale')),
  account_status text not null check (account_status in ('active','restricted','pending verification')),
  region         text not null,
  kyc_status     text not null check (kyc_status in ('pending','approved','review required')),
  support_notes  text not null default '',
  -- Matching keys, computed once. "Lagos Ledger" and "LagosLedger" are one company.
  company_key    text generated always as (regexp_replace(lower(company_name), '[^a-z0-9]', '', 'g')) stored,
  email_key      text generated always as (lower(contact_email)) stored,
  updated_at     timestamptz not null default now()
);
create index if not exists customers_company_key on public.customers (company_key);
create index if not exists customers_email_key on public.customers (email_key);

create table if not exists public.transactions (
  transaction_id      text primary key check (transaction_id ~ '^TXN-[0-9]{4}$'),
  customer_id         text not null references public.customers(customer_id),
  transaction_type    text not null check (transaction_type in ('incoming transfer','outgoing payout','invoice payment')),
  amount              numeric(14,2) not null check (amount >= 0),
  currency            char(3) not null,
  destination_country text,
  status              text not null check (status in ('processing','completed','delayed','failed','review required')),
  created_at          date not null,
  estimated_arrival   date,
  support_summary     text not null,
  updated_at          timestamptz not null default now()
);

create table if not exists public.payouts (
  payout_id      text primary key check (payout_id ~ '^PAY-[0-9]{4}$'),
  transaction_id text references public.transactions(transaction_id),
  customer_id    text not null references public.customers(customer_id),
  recipient_name text not null,
  amount         numeric(14,2) not null check (amount >= 0),
  currency       char(3) not null,
  status         text not null check (status in ('scheduled','processing','completed','failed','review required')),
  scheduled_for  date,
  failure_reason text,
  updated_at     timestamptz not null default now()
);
create index if not exists payouts_transaction on public.payouts (transaction_id);
