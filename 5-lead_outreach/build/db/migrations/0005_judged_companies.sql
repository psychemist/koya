-- ============================================================
-- Every judgement, kept beyond the run that made it.
--
-- Today a run throws away everything it learned. `delivered_domains` records
-- only the companies that QUALIFIED, so every "this is an agency, reject" is
-- discarded at run end and the next run on a similar ICP pays Apify, Firecrawl
-- and Claude to reach the same conclusion again.
--
-- This table CHANGES NO DECISION. It is instrumentation, written so the
-- overlap between runs can be measured before a reuse subsystem is built on
-- the assumption that overlap exists. One run cannot answer that, and building
-- the cache first would be pinning a price without reading the table.
--
-- Keyed by (domain, fingerprint) because a verdict is a function of the
-- company AND the criteria: the same company judged under different targeting
-- is a different judgement, not a duplicate.
-- ============================================================

create table if not exists public.judged_companies (
  company_domain  text not null,
  icp_fingerprint text not null,
  verdict         text not null,
  run_id          uuid references public.runs(id) on delete set null,
  judged_at       timestamptz not null default now(),
  primary key (company_domain, icp_fingerprint)
);

create index if not exists judged_companies_fingerprint_idx
  on public.judged_companies (icp_fingerprint);

alter table public.judged_companies enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.judged_companies from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.judged_companies from authenticated;
  end if;
end $$;
