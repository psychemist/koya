-- ============================================================
-- Firecrawl consumption, in the unit that is actually finite.
--
-- The account is on the free plan: 1000 credits a month, no dollars. So $0.00
-- of Firecrawl spend is the CORRECT dollar figure, and recording nothing at
-- all was still wrong. Credits are the real constraint, they are shared, they
-- reset monthly, and nothing in this build counted them: a run could not say
-- how many it used and no run could see what earlier runs had left.
--
-- The column sits on the ledger rather than in its own table because the
-- ledger is already the one place a run's consumption is recorded, and a
-- second place to look is how the two disagree.
-- ============================================================

alter table public.spend_ledger
  add column if not exists credits integer not null default 0;

comment on column public.spend_ledger.credits is
  'Provider credits consumed, for providers billed in credits rather than dollars.';
