-- ============================================================
-- Count the re-judgements, because the upsert was erasing them.
--
-- 0005 keyed judged_companies by (domain, fingerprint) and updated the row on
-- conflict, which is right for a cache and wrong for a measurement: the second
-- time a company was judged under the same criteria simply overwrote the
-- first, and the number the table exists to produce, "how many judgements
-- would a cache have skipped", was destroyed on write.
--
-- `times_judged` is that number. Summed as (times_judged - 1) across the
-- table, it is exactly the work a cross-run cache would have avoided.
-- ============================================================

alter table public.judged_companies
  add column if not exists times_judged integer not null default 1,
  add column if not exists first_judged_at timestamptz not null default now();
