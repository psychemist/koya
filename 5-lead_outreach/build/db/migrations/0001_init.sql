-- ============================================================
-- Koya Lead Desk: schema + row level security
--
-- Three ideas:
-- 1. LIMITS ARE COLUMNS. candidate_budget / scrape_budget / apify_cap_usd
--    live on the run. The agent reads them through a tool and can never
--    raise them, because the tool reads the row, not the argument.
-- 2. EVIDENCE IS A CONSTRAINT. A lead cannot be stored `qualified` with
--    no fit_reasons and no source_urls. Enforced by CHECK, not by prompt.
-- 3. RLS IS ON EVERYWHERE AND anon GETS NOTHING. Supabase exposes
--    PostgREST whether or not we use it.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- runs ----------
create table if not exists public.runs (
  id                  uuid primary key default gen_random_uuid(),
  idempotency_key     text unique not null,
  objective           text not null,
  icp                 jsonb,                      -- written by save_icp before any paid call
  status              text not null default 'queued',
  version             integer not null default 0,
  needs_clarification text,

  candidate_budget    integer not null default 40,
  candidates_used     integer not null default 0,
  scrape_budget       integer not null default 30,
  scrapes_used        integer not null default 0,
  target_leads        integer not null default 10,
  apify_cap_usd       numeric(10,4) not null default 0.30,

  apify_spend_usd     numeric(10,4) not null default 0,
  claude_cost_usd     numeric(10,4) not null default 0,
  agent_turns         integer not null default 0,

  shortfall_reason    text,
  error_message       text,
  claimed_by          text,
  claimed_at          timestamptz,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz,

  constraint runs_status_valid check (status in (
    'queued','refining_icp','discovering','researching','drafting',
    'complete','partial','failed'
  ))
);
create index if not exists runs_claimable on public.runs (status, claimed_at)
  where status not in ('complete','partial','failed');

-- ---------- candidates: discovered, not yet judged ----------
create table if not exists public.candidates (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.runs(id) on delete cascade,
  company_name   text not null,
  company_domain text not null,                   -- normalised registrable domain
  discovery_meta jsonb not null default '{}',
  assessed       boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (run_id, company_domain)
);

-- ---------- leads ----------
create table if not exists public.leads (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null references public.runs(id) on delete cascade,
  company_name         text not null,
  company_domain       text not null,
  qualification_status text not null,
  confidence           numeric(3,2) not null,
  fit_reasons          text[] not null default '{}',
  concerns             text[] not null default '{}',
  source_urls          text[] not null default '{}',
  source_summary       text,
  drafts_blocked       text,
  human_status         text,                      -- null | accepted | rejected
  human_note           text,
  created_at           timestamptz not null default now(),

  unique (run_id, company_domain),
  constraint leads_status_valid check (qualification_status in
    ('qualified','not_qualified','needs_review')),
  constraint leads_confidence_range check (confidence >= 0 and confidence <= 1),
  -- IDEA 2: a qualified lead without evidence is not storable.
  constraint leads_qualified_needs_evidence check (
    qualification_status <> 'qualified'
    or (array_length(fit_reasons,1) >= 1
        and array_length(source_urls,1) >= 1
        and confidence >= 0.40)
  )
);

-- ---------- outreach drafts ----------
create table if not exists public.outreach_drafts (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references public.leads(id) on delete cascade,
  step               integer not null,            -- 1,2,3 = email; 0 = linkedin
  subject            text,
  body               text not null,
  personalization_note text,
  source_url         text,
  gate_results       jsonb not null default '{}',
  edited_by_human    boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (lead_id, step),
  constraint drafts_step_valid check (step between 0 and 3)
);

-- ---------- tool calls: written by the wrapper, not the agent ----------
create table if not exists public.tool_calls (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.runs(id) on delete cascade,
  tool_name      text not null,
  purpose        text,
  input_summary  jsonb not null default '{}',     -- redacted
  result_summary jsonb not null default '{}',     -- redacted
  status         text not null default 'started', -- started|ok|error|denied
  error_code     text,
  error_message  text,
  cost_usd       numeric(10,4) not null default 0,
  duration_ms    integer,
  created_at     timestamptz not null default now()
);
create index if not exists tool_calls_by_run on public.tool_calls (run_id, created_at);

-- ---------- scraped pages: evidence, retained with the run ----------
create table if not exists public.scraped_pages (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references public.runs(id) on delete cascade,
  company_domain    text not null,
  url               text not null,
  content_hash      text not null,
  raw_text          text,                         -- reviewer can see it; agent cannot
  screened_summary  text,
  injection_flagged boolean not null default false,
  injection_reason  text,
  http_status       integer,
  provider          text,
  created_at        timestamptz not null default now()
);
create index if not exists scraped_pages_by_run on public.scraped_pages (run_id, created_at);

-- ---------- global scrape cache: do not pay to read a page twice ----------
create table if not exists public.scrape_cache (
  url_norm     text primary key,
  content_hash text not null,
  markdown     text not null,
  http_status  integer,
  fetched_at   timestamptz not null default now()
);

-- ---------- spend ledger: the primary cost control ----------
create table if not exists public.spend_ledger (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid references public.runs(id) on delete set null,
  provider   text not null,                       -- apify | claude | firecrawl
  amount_usd numeric(10,4) not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists spend_by_day on public.spend_ledger (provider, created_at);

-- ---------- delivered domains: never re-deliver, never re-spend on ----------
create table if not exists public.delivered_domains (
  company_domain text primary key,
  first_run_id   uuid references public.runs(id) on delete set null,
  delivered_at   timestamptz not null default now()
);

-- ---------- notifications: the claim row, written before anything is sent ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.runs(id) on delete cascade,
  kind       text not null,
  -- Scope keeps per-lead kinds addressable without breaking run-level
  -- idempotency. It is '' rather than NULL because Postgres treats NULLs as
  -- distinct in a UNIQUE, which would let a run-level notification fire twice.
  scope      text not null default '',
  recipient  text,
  lane       text not null default 'n8n',      -- n8n | resend_fallback | none
  -- `pending` is written when the row is CLAIMED, before anything is emitted.
  -- A worker that dies mid-emit leaves a visible loose end rather than a row
  -- asserting somebody was told.
  state      text not null default 'pending',  -- pending|sent|degraded|failed|skipped_not_configured
  error_code text,
  created_at timestamptz not null default now(),
  unique (run_id, kind, scope)
);

-- ============================================================
-- ROW LEVEL SECURITY. On everywhere, anon gets nothing.
-- The app connects as a privileged role and is itself the authorisation
-- layer. This is defence in depth against the PostgREST Data API that
-- Supabase exposes whether or not we use it.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['runs','candidates','leads','outreach_drafts',
                           'tool_calls','scraped_pages','scrape_cache',
                           'spend_ledger','delivered_domains','notifications']
  loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;
