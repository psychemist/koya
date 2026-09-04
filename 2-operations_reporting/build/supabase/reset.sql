-- ============================================================
-- Koya Talent — full reset
--
-- Drops every object schema.sql creates, so the next run of schema.sql
-- builds the database from nothing. Use this to purge stale reports —
-- including low-confidence runs published before the prompt and
-- validation fixes — rather than trying to edit them in place.
--
--   1. Run this file in the Supabase SQL editor.
--   2. Then run supabase/schema.sql.
--
-- Order matters: functions and views first, then tables. `cascade` on the
-- tables removes the foreign keys between them, so report_runs can go
-- without dropping its children by hand first.
--
-- This touches ONLY objects this project created. Supabase's own schemas
-- (auth, storage, realtime) are never referenced. It is deliberately not
-- `drop schema public cascade`, which would take extensions and anything
-- else living in public with it.
--
-- THIS DELETES EVERY PUBLISHED REPORT AND EVERY SOURCE SNAPSHOT. There is
-- no undo. The reports rebuild on the next workflow run; the source data
-- is re-fetched from Sheets, Airtable and the People Ops API, so nothing
-- here is the system of record.
-- ============================================================

drop function if exists public.publish_report(jsonb)        cascade;
drop function if exists public.record_failed_run(jsonb)     cascade;
drop function if exists public.prune_old_report_runs()      cascade;

drop view if exists public.dashboard_latest                 cascade;
drop view if exists public.latest_report_runs               cascade;
drop view if exists public.people_headcount_by_department   cascade;
drop view if exists public.report_freshness                 cascade;

drop table if exists public.data_quality_warnings           cascade;
drop table if exists public.report_insights                 cascade;
drop table if exists public.report_breakdowns               cascade;
drop table if exists public.report_metrics                  cascade;
drop table if exists public.report_runs                     cascade;
drop table if exists public.sales_records                   cascade;
drop table if exists public.delivery_projects               cascade;
drop table if exists public.people_records                  cascade;

-- Confirms the reset actually emptied the namespace. Expect 0 rows; any
-- row returned is an object schema.sql will not recreate cleanly.
select table_name as leftover
from information_schema.tables
where table_schema = 'public'
  and table_name in ('report_runs','report_metrics','report_breakdowns',
                     'report_insights','data_quality_warnings','sales_records',
                     'delivery_projects','people_records');
