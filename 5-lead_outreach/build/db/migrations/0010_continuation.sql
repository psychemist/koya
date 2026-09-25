-- ============================================================
-- A short run can be continued instead of started again.
--
-- A run that ends `partial` has an ICP that was worked out and paid for, a set
-- of companies already judged, and usually a pile of candidates it discovered
-- and never got to. Starting again from the objective re-derives the ICP, pays
-- Apify to rediscover the same companies, and pays Claude to re-judge them.
--
-- The child is a separate run with its own budgets and its own audit trail,
-- which is the point: reopening the parent would make its finished_at a lie
-- and its spend unattributable.
-- ============================================================

alter table public.runs
  add column if not exists parent_run_id uuid references public.runs(id) on delete set null;

create index if not exists runs_parent_idx on public.runs (parent_run_id);
