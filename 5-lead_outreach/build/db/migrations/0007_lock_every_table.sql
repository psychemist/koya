-- ============================================================
-- Lock every table in public, including the ones no migration created.
--
-- 0001 enabled RLS and withdrew anon/authenticated access over a HAND-WRITTEN
-- LIST of tables. Two things escape a list: `schema_migrations`, which the
-- migrate script creates before any migration runs, and every table added
-- afterwards. An audit on 2026-09-25 found `schema_migrations` with RLS off
-- and `anon` holding write access to it.
--
-- So this loops over what is actually present rather than over what somebody
-- remembered. It also resets the DEFAULT privileges: without that, Supabase
-- re-grants `anon` on every table created from here on and the same hole
-- reopens the next time a table is added.
--
-- Nothing here reads, changes or removes a row. The application connects as a
-- role that bypasses RLS, so this is defence in depth behind the real control,
-- which is that the service credentials never reach a browser.
-- ============================================================

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t.tablename);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t.tablename);
    end if;
  end loop;
end $$;

-- Future tables. This is the part that stops the hole reopening.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    alter default privileges in schema public revoke all on tables from anon;
    alter default privileges in schema public revoke all on sequences from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    alter default privileges in schema public revoke all on tables from authenticated;
    alter default privileges in schema public revoke all on sequences from authenticated;
  end if;
end $$;
