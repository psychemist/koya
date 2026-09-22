-- ============================================================
-- Koya Lead Desk: people, and who created what
--
-- Two roles, and the difference between them is what you can SEE, not what
-- you can approve. Nothing leaves the building in this system, so there is no
-- approval gate to separate duties over. What there is instead is a shared
-- Apify budget drawn against a cohort account, and somebody has to be able to
-- see where it went.
--
--   operator: starts runs, reviews and edits their own, exports them.
--   admin:    all of that, plus the whole team's history and the spend behind it.
-- ============================================================

create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text not null,
  role          text not null default 'operator',   -- operator | admin
  password_hash text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,

  constraint users_role_valid check (role in ('operator', 'admin'))
);

-- A run belongs to the person who started it. Nullable because runs created
-- before this migration have no owner to attribute, and inventing one would be
-- worse than admitting the gap.
alter table public.runs
  add column if not exists created_by uuid references public.users(id) on delete set null;

create index if not exists runs_by_creator on public.runs (created_by, created_at desc);

-- ============================================================
-- RLS on the new table too. Supabase exposes PostgREST whether or not we use
-- it, and a users table is the one worth reaching for.
-- ============================================================
do $$
begin
  execute 'alter table public.users enable row level security';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.users from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.users from authenticated';
  end if;
end $$;
