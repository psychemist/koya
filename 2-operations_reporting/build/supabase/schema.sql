-- ============================================================
-- Koya Talent — AI Operations Reporting System
-- Supabase schema, row level security, and dashboard views
--
-- Run once, top to bottom, in the Supabase SQL editor.
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE.
--
-- THE TWO IDEAS THIS SCHEMA IS BUILT ON
--
-- 1. EVERY TABLE HAS A NATURAL KEY, so every write is an UPSERT and the
--    workflow is safe to run twice. Nothing is keyed on a clock or a
--    sequence. Re-running "last 30 days" rewrites one report; it does not
--    add a second one for the dashboard to choose between.
--
-- 2. THE BROWSER KEY IS READ-ONLY AND CANNOT SEE EMPLOYEE ROWS. The dashboard
--    ships a publishable key to the browser, so the `anon` role is treated as
--    hostile: SELECT only, and employee-level lifecycle records are reachable
--    only through an aggregated view. Writes require a secret key, which lives
--    in n8n's credential store and never reaches a browser.
--
--    KEYS vs ROLES — the two are easy to conflate and only one of them
--    changed. Supabase replaced its legacy JWT keys with opaque ones:
--
--      sb_publishable_…  replaces the legacy `anon` key        (browser)
--      sb_secret_…       replaces the legacy `service_role` key (n8n)
--
--    The Postgres roles did NOT change. A publishable key still resolves to
--    the `anon` role (or `authenticated`, when a user JWT is attached), and a
--    secret key still resolves to `service_role`, which bypasses RLS. So every
--    `to anon, authenticated` policy below is unaffected by the migration and
--    this file needs no edit when the keys are swapped over.
--
--    The gain is operational: secret keys are individually revocable, so one
--    can be rotated without invalidating every other key in the project — the
--    legacy service_role key could only be rotated by rotating the JWT secret,
--    which broke everything at once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Report runs — one row per (period, window, anchor)
-- ------------------------------------------------------------
create table if not exists public.report_runs (
  run_id            text primary key,
  period_key        text not null,
  period_label      text not null,
  period_start      date not null,
  period_end        date not null,
  period_days       integer,
  reference_date    date not null,
  compare_label     text,
  compare_start     date,
  compare_end       date,
  -- succeeded | partial | failed. `partial` means at least one source was
  -- unreachable: the report is publishable but must not be read as complete.
  run_status        text not null default 'succeeded',
  -- 'writing' while the child rows are still being written, 'published' once
  -- they all landed. The dashboard view shows ONLY published runs, so a write
  -- chain that dies half way leaves the previous good report on screen instead
  -- of a run row with no metrics behind it. Publication is the last write, and
  -- it is what makes the whole multi-table update effectively atomic to a reader.
  publish_state     text not null default 'writing',
  metrics_hash      text,
  insight_source    text,          -- claude | deterministic_fallback
  model             text,
  confidence        text,          -- high | medium | low, AFTER validation
  grounded          boolean,       -- did every figure trace back to the data
  failure_reason    text,
  source_health     jsonb,
  failed_sources    jsonb,
  dq_errors         integer default 0,
  dq_warnings       integer default 0,
  dq_info           integer default 0,
  input_tokens      integer,
  output_tokens     integer,
  requested_by      text,
  computed_at       timestamptz,
  -- Set when an attempt to REFRESH this report fails. Distinct from
  -- failure_reason, which describes the run in the row it sits on. These
  -- describe the most recent failed attempt at replacing a report that may
  -- still be published and perfectly readable, so the dashboard can say
  -- "this is stale, and here is why" without the report being touched.
  last_failure_at   timestamptz,
  last_failure_reason text,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- ... and add them to a table that already exists, for anyone upgrading.
-- `create table if not exists` above is a no-op on an existing database, so
-- without these two lines an upgrade would silently skip the new columns.
alter table public.report_runs add column if not exists last_failure_at     timestamptz;
alter table public.report_runs add column if not exists last_failure_reason text;

create index if not exists report_runs_period_idx
  on public.report_runs (period_key, period_end desc);
create index if not exists report_runs_updated_idx
  on public.report_runs (updated_at desc);

-- ------------------------------------------------------------
-- 2. Metrics — long and narrow, one row per figure
--
-- A wide table would need a migration and a dashboard redeploy every time
-- a metric is added. Here a new metric is a new row. Each row carries its
-- comparison value and, when it could not be calculated, the reason — so
-- the dashboard never has to invent an explanation for a blank tile.
-- ------------------------------------------------------------
create table if not exists public.report_metrics (
  run_id             text not null references public.report_runs(run_id) on delete cascade,
  domain             text not null,   -- sales | project_delivery | people_ops
  metric_key         text not null,
  metric_value       numeric,
  metric_text        text,
  is_available       boolean not null default true,
  unavailable_reason text,
  previous_value     numeric,
  change             numeric,
  percent_change     numeric,
  direction          text,            -- up | down | flat | stable | not_comparable
  updated_at         timestamptz not null default now(),
  primary key (run_id, domain, metric_key)
);

-- ------------------------------------------------------------
-- 3. Breakdowns — the grouped metrics (by lead source, team, department)
-- ------------------------------------------------------------
create table if not exists public.report_breakdowns (
  run_id        text not null references public.report_runs(run_id) on delete cascade,
  domain        text not null,
  breakdown_key text not null,   -- revenue_by_lead_source | delivery_load_by_team | ...
  item_key      text not null,   -- Inbound | Automation | Engineering | ...
  rank          integer,
  values        jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (run_id, domain, breakdown_key, item_key)
);

-- ------------------------------------------------------------
-- 4. AI insights — one row per run
--
-- `grounded`, `unverified_figures` and `model_confidence_claimed` are stored
-- alongside the prose on purpose. They are the audit trail for whether the
-- commentary can be trusted, and the dashboard renders them rather than
-- hiding them.
-- ------------------------------------------------------------
create table if not exists public.report_insights (
  run_id                  text primary key references public.report_runs(run_id) on delete cascade,
  insight_source          text not null,
  model                   text,
  executive_summary       text,
  -- One written section per department, so the manager who owns Sales can
  -- read Sales without reading the whole report. Kept as jsonb rather than
  -- three columns: the set of departments is data, not schema.
  department_insights     jsonb not null default '[]'::jsonb,
  risks_and_anomalies     jsonb not null default '[]'::jsonb,
  recommended_actions     jsonb not null default '[]'::jsonb,
  ai_data_quality_warnings jsonb not null default '[]'::jsonb,
  confidence              text,
  model_confidence_claimed text,
  grounded                boolean,
  unverified_figures      jsonb not null default '[]'::jsonb,
  validation_notes        jsonb not null default '[]'::jsonb,
  failure_reason          text,
  stop_reason             text,
  input_tokens            integer,
  output_tokens           integer,
  estimated_input_tokens  integer,
  generated_at            timestamptz,
  updated_at              timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5. Data quality warnings — the machine-detected issues
-- ------------------------------------------------------------
create table if not exists public.data_quality_warnings (
  run_id      text not null references public.report_runs(run_id) on delete cascade,
  ordinal     integer not null,
  source      text not null,
  severity    text not null,   -- error | warning | info
  code        text not null,
  record_id   text,
  message     text not null,
  -- WHERE THE ISSUE SITS RELATIVE TO THE REPORTING WINDOW.
  -- The sources are read whole, so the normalizers see every issue in them,
  -- including issues in records this period never touches. A warning about a
  -- March lead shown under a heading that says "Last 30 days" contradicts the
  -- numbers above it. Compute Metrics keeps only the issues that bear on the
  -- window; these columns record why each one is here.
  --   in_period       a record dated inside the window
  --   undated_record  a record with no usable date — excluded from every window
  --   run             no record behind it: a source outage, an empty period
  record_date date,
  scope       text not null default 'run',
  in_period   boolean not null default true,
  updated_at  timestamptz not null default now(),
  primary key (run_id, ordinal)
);

-- ... and on a database that already has these tables, where the
-- `create table if not exists` above is a no-op.
alter table public.report_insights add column if not exists department_insights jsonb not null default '[]'::jsonb;
alter table public.data_quality_warnings add column if not exists record_date date;
alter table public.data_quality_warnings add column if not exists scope       text not null default 'run';
alter table public.data_quality_warnings add column if not exists in_period   boolean not null default true;

create index if not exists dq_severity_idx
  on public.data_quality_warnings (run_id, severity);

-- ------------------------------------------------------------
-- 6. Cleaned source records
--
-- Stored so a figure on the dashboard can be traced to the rows behind it
-- by someone who has no Airtable login. Keyed on the business id, so a
-- re-run refreshes the rows it touched and leaves the rest of history alone.
-- ------------------------------------------------------------
create table if not exists public.sales_records (
  lead_id          text primary key,
  lead_date        date,
  status           text,
  status_raw       text,
  deal_amount      numeric,
  lead_source      text,
  spend_month      text,
  is_usable        boolean not null default true,
  record_issues    jsonb not null default '[]'::jsonb,
  last_seen_run_id text,
  updated_at       timestamptz not null default now()
);

create table if not exists public.delivery_projects (
  project_id       text primary key,
  project_name     text,
  team             text,
  owner            text,
  kickoff_date     date,
  due_date         date,
  completed_date   date,
  status           text,
  status_raw       text,
  budgeted_cost    numeric,
  actual_cost      numeric,
  budget_variance  numeric,
  delay_days       integer,
  is_usable        boolean not null default true,
  record_issues    jsonb not null default '[]'::jsonb,
  last_seen_run_id text,
  updated_at       timestamptz not null default now()
);

-- The most sensitive table in the system: individual employment lifecycle,
-- including exit dates. It is NOT readable with the publishable key. The
-- dashboard reads the aggregated view below instead.
create table if not exists public.people_records (
  employee_id           text primary key,
  department            text,
  role                  text,
  application_date      date,
  offer_accepted_date   date,
  start_date            date,
  exit_date             date,
  status                text,
  status_raw            text,
  time_to_hire_days     integer,
  offer_acceptance_days integer,
  is_usable             boolean not null default true,
  record_issues         jsonb not null default '[]'::jsonb,
  last_seen_run_id      text,
  updated_at            timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
--
-- RLS is enabled on every table. With RLS on and no permissive policy for a
-- role, that role gets nothing — so the default is "no access" and each
-- grant below is deliberate.
--
-- The secret key (sb_secret_…) resolves to the `service_role` role, which
-- bypasses RLS entirely. That is the key n8n holds, and it is the ONLY way
-- anything is ever written.
-- ============================================================
alter table public.report_runs           enable row level security;
alter table public.report_metrics        enable row level security;
alter table public.report_breakdowns     enable row level security;
alter table public.report_insights       enable row level security;
alter table public.data_quality_warnings enable row level security;
alter table public.sales_records         enable row level security;
alter table public.delivery_projects     enable row level security;
alter table public.people_records        enable row level security;

-- Read-only access for the dashboard. `for select` only: there is no insert,
-- update or delete policy for anon anywhere in this file, so the publishable
-- key the dashboard publishes to every visitor cannot alter a single row.
--
-- `anon` here is the Postgres role, not the old key name. It is what both a
-- legacy anon key and a new publishable key resolve to, so these policies did
-- not need rewriting for the key migration.
do $$
declare t text;
begin
  foreach t in array array[
    'report_runs', 'report_metrics', 'report_breakdowns',
    'report_insights', 'data_quality_warnings',
    'sales_records', 'delivery_projects'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_anon_read', t);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (true)',
      t || '_anon_read', t
    );
  end loop;
end $$;

-- people_records deliberately gets NO anon policy. Employee-level records
-- with exit dates are not something a publishable browser key should reach,
-- and the dashboard does not need them — it reads dashboard_latest, which
-- carries headcount as an already-aggregated metric on the run.

-- ============================================================
-- VIEWS
-- ============================================================

-- DROPPED, NOT REPLACED. `create or replace view` can only add columns at the
-- END of the list — it refuses to reorder or rename one — so a schema that
-- gains a column in the middle of a view (department_insights, failed_sources)
-- fails to apply on a database that already has the old view, with an error
-- that reads like a permissions problem. Dropping first makes this file
-- genuinely re-runnable, which is what the header promises.
--
-- Order matters: the dependants go first, and each is recreated below with its
-- grant and its security_invoker setting.
drop view if exists public.report_freshness;
drop view if exists public.dashboard_latest;
drop view if exists public.latest_report_runs;

-- The latest run for each reporting period. The dashboard's period selector
-- reads exactly one row from here, so it never has to decide which of several
-- runs is current.
create or replace view public.latest_report_runs as
select distinct on (period_key) *
from public.report_runs
where publish_state = 'published'
order by period_key, updated_at desc;

-- Everything the dashboard needs for one period, in a single request.
create or replace view public.dashboard_latest as
select
  r.run_id,
  r.period_key,
  r.period_label,
  r.period_start,
  r.period_end,
  r.period_days,
  r.reference_date,
  r.compare_label,
  r.run_status,
  r.confidence,
  r.grounded,
  r.insight_source,
  r.model,
  r.failure_reason,
  r.source_health,
  -- The list of sources that could not be read. The dashboard names them in
  -- the "this report is incomplete" banner; without this column it could only
  -- say that something failed, which is the least useful half of the message.
  r.failed_sources,
  r.compare_start,
  r.compare_end,
  r.dq_errors,
  r.dq_warnings,
  r.dq_info,
  r.updated_at,
  -- Staleness. Populated by record_failed_run() when a refresh fails, and
  -- cleared by publish_report() when one succeeds, so the banner appears and
  -- disappears on its own.
  r.last_failure_at,
  r.last_failure_reason,
  i.executive_summary,
  i.department_insights,
  i.risks_and_anomalies,
  i.recommended_actions,
  i.ai_data_quality_warnings,
  i.unverified_figures,
  i.validation_notes,
  (select coalesce(jsonb_agg(to_jsonb(m) order by m.domain, m.metric_key), '[]'::jsonb)
     from public.report_metrics m where m.run_id = r.run_id)      as metrics,
  (select coalesce(jsonb_agg(to_jsonb(b) order by b.domain, b.breakdown_key, b.rank), '[]'::jsonb)
     from public.report_breakdowns b where b.run_id = r.run_id)   as breakdowns,
  (select coalesce(jsonb_agg(to_jsonb(d) order by
            case d.severity when 'error' then 0 when 'warning' then 1 else 2 end, d.ordinal), '[]'::jsonb)
     from public.data_quality_warnings d where d.run_id = r.run_id) as data_quality
from public.latest_report_runs r
left join public.report_insights i on i.run_id = r.run_id;

-- Aggregated People Ops, safe for the publishable key: counts by department,
-- with no employee_id, no dates, and no way back to an individual.
create or replace view public.people_headcount_by_department as
select
  department,
  count(*) filter (where start_date is not null and exit_date is null) as active_headcount,
  count(*) filter (where exit_date is not null)                        as total_exits,
  count(*)                                                             as total_records
from public.people_records
group by department
order by active_headcount desc;

-- Views run with the privileges of their owner, so an anon-readable view over
-- a table anon cannot read is a privilege-escalation hole. security_invoker
-- forces the caller's own RLS to apply, and EVERY view here is marked with it.
--
-- people_headcount_by_department used to be the one exception: invoker OFF
-- plus a grant to anon, deliberately, so the browser could read department
-- aggregates over people_records without being able to read a single employee
-- row. The reasoning was sound and the exposure was narrow -- four aggregate
-- columns, no employee_id, no dates. It was still the only object in this
-- schema through which the publishable key reached RLS-protected rows, and
-- Supabase's security advisor flags it CRITICAL on sight.
--
-- What settled it: nothing reads it. The dashboard fetches dashboard_latest
-- and takes headcount from the metrics JSON already on the run; no Code node
-- and no query in this repo touches this view. So the exception was buying a
-- standing RLS bypass, a critical advisor finding, and the risk that a later
-- change quietly widens it -- in exchange for a capability nobody used.
--
-- It stays as a view, because it is the right shape if the dashboard ever
-- does want a department breakdown. It just is not reachable by the browser
-- key any more. Restoring that is two lines, and should be a decision someone
-- makes on purpose rather than one they inherit.
alter view public.latest_report_runs             set (security_invoker = on);
alter view public.dashboard_latest               set (security_invoker = on);
alter view public.people_headcount_by_department set (security_invoker = on);

grant select on public.latest_report_runs             to anon, authenticated;
grant select on public.dashboard_latest               to anon, authenticated;

-- Explicit, and not merely omitted: re-running this file over a database that
-- had the old grant must actually take it away.
revoke select on public.people_headcount_by_department from anon, authenticated;

-- ============================================================
-- RETENTION
--
-- Run ids are deterministic, so the table cannot grow without bound from
-- re-runs — only from genuinely new custom date ranges. This trims those.
-- Wire it to pg_cron if custom ranges are used heavily; otherwise run it by
-- hand once a quarter.
-- ============================================================
create or replace function public.prune_old_report_runs(keep_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare removed integer;
begin
  with doomed as (
    delete from public.report_runs
    where period_key = 'custom'
      and updated_at < now() - make_interval(days => keep_days)
    returning 1
  )
  select count(*) into removed from doomed;
  return removed;
end $$;

revoke all on function public.prune_old_report_runs(integer) from public, anon;

-- ============================================================
-- VERIFY
--   select run_id, period_label, run_status, confidence, grounded, updated_at
--     from public.latest_report_runs order by period_key;
--
--   -- must return 0 rows when run with the publishable key (anon role):
--   select count(*) from public.people_records;
-- ============================================================


-- ============================================================
-- TRANSACTIONAL PUBLISH
--
-- Everything above this point describes the tables. This section replaces
-- the way they are WRITTEN.
--
-- Before: the workflow made ten sequential PostgREST calls — one per table,
-- then an eleventh to flip publish_state to 'published'. That flip is what
-- made the update atomic *to a reader*: the dashboard view filters on
-- publish_state, so a chain that died half way left the previous good report
-- on screen. That part worked and is kept.
--
-- What it did not solve:
--
--   1. Ten transactions, not one. A chain that dies at table six leaves the
--      first five written under a run_id that never publishes. Nothing reads
--      them, but nothing removes them either; they accumulate until the
--      pruning job runs.
--   2. Ten chances to fail instead of one, each with its own retry, its own
--      timeout and its own error to interpret at 6am.
--   3. Stale children survive a re-run. The child tables were UPSERTED, so a
--      row written by an earlier attempt that no longer exists in the new
--      payload stayed behind. Re-running a period after fixing the source
--      data left the fixed warnings in `data_quality_warnings` and the
--      removed lead sources in `report_breakdowns`. The dashboard showed
--      warnings that no longer applied, which is the one thing a data
--      quality panel must never do.
--
-- publish_report() takes the whole payload as one jsonb document and does
-- the lot in a single transaction. It either commits everything or changes
-- nothing, and the previous report survives untouched either way.
--
-- Point 3 is fixed by construction rather than by cleanup: the run's own
-- rows are DELETED before the new ones go in, so what you get is a
-- replacement rather than a merge.
--
-- This is still the Supabase Data API. `POST /rest/v1/rpc/publish_report`
-- goes through PostgREST with the same service-role credential the upserts
-- used. Nothing new is exposed and nothing else changes.
-- ============================================================

-- The `last_failure_at` / `last_failure_reason` columns these functions
-- write live with the report_runs table definition near the top of this
-- file, so every view that reads `report_runs` picks them up without a
-- rebuild. Rebuilding a view here would have been the subtler option and a
-- worse one: CREATE OR REPLACE VIEW resets reloptions, which would silently
-- drop `security_invoker` and leave the read path running with the view
-- owner's rights.

-- ------------------------------------------------------------
-- publish_report(payload) — the whole report, one transaction
--
-- `payload` is the object built by the "Build Supabase Payloads" node,
-- unchanged:
--   { run_id, report_runs[1], report_metrics[], report_breakdowns[],
--     report_insights[1], data_quality_warnings[], sales_records[],
--     delivery_projects[], people_records[] }
--
-- Returns a row count per table so the workflow can verify the write
-- landed instead of assuming a 2xx meant what it hoped.
-- ------------------------------------------------------------
create or replace function public.publish_report(payload jsonb)
returns jsonb
language plpgsql
security definer
-- pg_catalog first so nothing on the caller's path can shadow a built-in.
-- Every table below is schema-qualified regardless.
set search_path = pg_catalog, public
as $$
declare
  v_run_id   text;
  v_step     text := 'validate payload';
  v_created  timestamptz;
  n_metrics  integer := 0;
  n_break    integer := 0;
  n_insights integer := 0;
  n_dq       integer := 0;
  n_sales    integer := 0;
  n_delivery integer := 0;
  n_people   integer := 0;
begin
  v_run_id := payload #>> '{report_runs,0,run_id}';

  if coalesce(v_run_id, '') = '' then
    raise exception 'publish_report: payload.report_runs[0].run_id is missing or empty'
      using errcode = '22023';
  end if;

  if jsonb_typeof(payload->'report_runs') is distinct from 'array'
     or jsonb_array_length(payload->'report_runs') <> 1 then
    raise exception 'publish_report: payload.report_runs must hold exactly one row, got %',
      coalesce(jsonb_typeof(payload->'report_runs'), 'null')
      using errcode = '22023';
  end if;

  -- Keep the original creation time across the replace below. Everything
  -- else about the run is allowed to change on a re-run; when the report
  -- was first produced is not.
  v_step := 'read existing run';
  select r.created_at into v_created
    from public.report_runs r
   where r.run_id = v_run_id;

  -- ---- replace, do not merge ---------------------------------
  -- Deleting the parent cascades to metrics, breakdowns, insights and data
  -- quality. That is the point: a row an earlier attempt wrote and this one
  -- does not is gone, rather than lingering as a warning nobody can action.
  v_step := 'clear previous version of this run';
  delete from public.report_runs where run_id = v_run_id;

  -- Two fields are overridden rather than taken from the payload:
  --   created_at    — preserved from the row we just deleted
  --   publish_state — set to 'published' here, because in a transaction
  --                   there is no window in which it could be anything else.
  --                   The workflow no longer needs a separate publish call.
  v_step := 'insert report_runs';
  insert into public.report_runs
  select * from jsonb_populate_recordset(
    null::public.report_runs,
    jsonb_build_array(
      (payload->'report_runs'->0)
        -- First write for this run: fall back to the payload's own
        -- updated_at rather than now(), so both timestamps come from the
        -- same clock and created_at <= updated_at always holds. n8n builds
        -- the payload seconds before Postgres receives it.
        || jsonb_build_object('created_at', coalesce(
             v_created,
             (payload #>> '{report_runs,0,updated_at}')::timestamptz,
             now()))
        || jsonb_build_object('publish_state', 'published')
    )
  );

  -- ---- children: straight inserts, the old rows are gone -------
  v_step := 'insert report_metrics';
  insert into public.report_metrics
  select * from jsonb_populate_recordset(
    null::public.report_metrics, coalesce(payload->'report_metrics', '[]'::jsonb));
  get diagnostics n_metrics = row_count;

  v_step := 'insert report_breakdowns';
  insert into public.report_breakdowns
  select * from jsonb_populate_recordset(
    null::public.report_breakdowns, coalesce(payload->'report_breakdowns', '[]'::jsonb));
  get diagnostics n_break = row_count;

  v_step := 'insert report_insights';
  insert into public.report_insights
  select * from jsonb_populate_recordset(
    null::public.report_insights, coalesce(payload->'report_insights', '[]'::jsonb));
  get diagnostics n_insights = row_count;

  v_step := 'insert data_quality_warnings';
  insert into public.data_quality_warnings
  select * from jsonb_populate_recordset(
    null::public.data_quality_warnings, coalesce(payload->'data_quality_warnings', '[]'::jsonb));
  get diagnostics n_dq = row_count;

  -- ---- dimension tables: refresh what this run saw -------------
  -- These are keyed on the BUSINESS id and shared across every run, so they
  -- are never cleared wholesale — a narrow period must not delete the
  -- records it did not look at. Only the ids present in this payload are
  -- replaced.
  v_step := 'refresh sales_records';
  delete from public.sales_records s
   where s.lead_id in (
     select i.lead_id from jsonb_populate_recordset(
       null::public.sales_records, coalesce(payload->'sales_records', '[]'::jsonb)) i);
  insert into public.sales_records
  select * from jsonb_populate_recordset(
    null::public.sales_records, coalesce(payload->'sales_records', '[]'::jsonb));
  get diagnostics n_sales = row_count;

  v_step := 'refresh delivery_projects';
  delete from public.delivery_projects d
   where d.project_id in (
     select i.project_id from jsonb_populate_recordset(
       null::public.delivery_projects, coalesce(payload->'delivery_projects', '[]'::jsonb)) i);
  insert into public.delivery_projects
  select * from jsonb_populate_recordset(
    null::public.delivery_projects, coalesce(payload->'delivery_projects', '[]'::jsonb));
  get diagnostics n_delivery = row_count;

  v_step := 'refresh people_records';
  delete from public.people_records p
   where p.employee_id in (
     select i.employee_id from jsonb_populate_recordset(
       null::public.people_records, coalesce(payload->'people_records', '[]'::jsonb)) i);
  insert into public.people_records
  select * from jsonb_populate_recordset(
    null::public.people_records, coalesce(payload->'people_records', '[]'::jsonb));
  get diagnostics n_people = row_count;

  -- A run that succeeds clears any failure recorded against this period by
  -- an earlier attempt, so the dashboard's staleness banner disappears on
  -- its own rather than needing a human to dismiss it.
  v_step := 'clear stale failure marker';
  update public.report_runs
     set last_failure_at = null, last_failure_reason = null
   where run_id = v_run_id;

  return jsonb_build_object(
    'ok',            true,
    'run_id',        v_run_id,
    'publish_state', 'published',
    'rows', jsonb_build_object(
      'report_metrics',        n_metrics,
      'report_breakdowns',     n_break,
      'report_insights',       n_insights,
      'data_quality_warnings', n_dq,
      'sales_records',         n_sales,
      'delivery_projects',     n_delivery,
      'people_records',        n_people
    )
  );

exception
  when others then
    -- Everything above is rolled back before this runs, so the previous
    -- report is still whole. Naming the step is the whole point: one RPC
    -- means one error message, and "publish_report failed" on its own would
    -- be a worse diagnostic than the ten calls it replaced.
    raise exception 'publish_report failed at step "%" for run % — % (SQLSTATE %)',
      v_step, coalesce(v_run_id, '<unknown>'), sqlerrm, sqlstate
      using errcode = sqlstate;
end;
$$;

comment on function public.publish_report(jsonb) is
  'Writes one complete report — run, metrics, breakdowns, insights, data quality and the cleaned source records — in a single transaction. Replaces the run''s existing child rows rather than merging into them, so a re-run cannot leave stale warnings behind. Commits everything or nothing.';

-- ------------------------------------------------------------
-- record_failed_run(payload) — a failure that destroys nothing
--
-- Called from the error path. `payload` is:
--   { report_runs: [ { ...one row, run_status 'failed'... } ],
--     affected_period_key: 'last_30_days' | null }
--
-- THE RULE THIS FUNCTION EXISTS TO ENFORCE: a failed refresh must never
-- damage the report it failed to refresh. Yesterday's published report is
-- still the best information available, and an outage at 6am is not a
-- reason to blank a dashboard. So the failure row is written with
-- publish_state 'failed' — which keeps it out of latest_report_runs and out
-- of the period selector entirely — and the affected period, if known, is
-- only STAMPED with when and why the refresh failed.
-- ------------------------------------------------------------
create or replace function public.record_failed_run(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run_id  text;
  v_period  text;
  v_reason  text;
  v_created timestamptz;
  v_stamped integer := 0;
begin
  v_run_id := payload #>> '{report_runs,0,run_id}';
  v_period := payload ->> 'affected_period_key';
  v_reason := payload #>> '{report_runs,0,failure_reason}';

  if coalesce(v_run_id, '') = '' then
    raise exception 'record_failed_run: payload.report_runs[0].run_id is missing'
      using errcode = '22023';
  end if;

  select r.created_at into v_created
    from public.report_runs r where r.run_id = v_run_id;

  delete from public.report_runs where run_id = v_run_id;

  -- publish_state is forced to 'failed', never taken from the payload. A
  -- failure row that reached 'published' would appear in the dashboard's
  -- period selector as a period called "Run failed".
  insert into public.report_runs
  select * from jsonb_populate_recordset(
    null::public.report_runs,
    jsonb_build_array(
      (payload->'report_runs'->0)
        || jsonb_build_object('created_at',    coalesce(v_created, now()))
        || jsonb_build_object('publish_state', 'failed')
        || jsonb_build_object('run_status',    'failed')
    )
  );

  -- Stamp the period this run was trying to refresh, if it got far enough
  -- to know. The report itself is left exactly as it was.
  if coalesce(v_period, '') <> '' then
    update public.report_runs
       set last_failure_at     = now(),
           last_failure_reason = v_reason
     where period_key = v_period
       and publish_state = 'published';
    get diagnostics v_stamped = row_count;
  end if;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run_id,
    'periods_marked_stale', v_stamped);
end;
$$;

comment on function public.record_failed_run(jsonb) is
  'Records a failed run without touching the report it failed to refresh. The failure row is never published, so it cannot enter the dashboard period selector; the affected period is only stamped with when and why the refresh failed.';

-- ------------------------------------------------------------
-- Execution rights
--
-- PostgREST exposes every function in the exposed schema, so a function that
-- is merely CREATED is already reachable at /rest/v1/rpc/<name> by whichever
-- roles can execute it. Postgres grants EXECUTE to PUBLIC by default, and
-- these two are SECURITY DEFINER — they run with the owner's rights and
-- bypass RLS. Left alone, that would hand anyone holding the publishable
-- key the ability to rewrite every report in the database.
--
-- So: revoke from everyone, then grant to service_role alone. n8n holds the
-- secret key; the browser never can.
-- ------------------------------------------------------------
revoke all on function public.publish_report(jsonb)    from public, anon, authenticated;
revoke all on function public.record_failed_run(jsonb) from public, anon, authenticated;
grant execute on function public.publish_report(jsonb)    to service_role;
grant execute on function public.record_failed_run(jsonb) to service_role;

-- ------------------------------------------------------------
-- Staleness, for the dashboard
--
-- One row per period saying whether the report on screen is current. Read
-- with the publishable key alongside dashboard_latest.
-- ------------------------------------------------------------
create or replace view public.report_freshness as
select
  period_key,
  period_label,
  run_status,
  updated_at              as published_at,
  last_failure_at,
  last_failure_reason,
  (last_failure_at is not null) as refresh_failing
from public.latest_report_runs;

grant select on public.report_freshness to anon, authenticated;
do $$ begin
  execute 'alter view public.report_freshness set (security_invoker = on)';
exception when others then null; end $$;
