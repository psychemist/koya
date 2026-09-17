-- ============================================================
-- Koya Content Desk — Supabase schema + row level security
--
-- Run top to bottom in the Supabase SQL editor, or via `npm run migrate`.
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE / idempotent.
--
-- THE THREE IDEAS THIS SCHEMA IS BUILT ON
--
-- 1. IDEMPOTENCY IS A CONSTRAINT, NOT AN INTENTION.
--    `content_requests.idempotency_key` and `publish_queue.idempotency_key`
--    are UNIQUE. A replayed intake returns the same request; a retry after a
--    provider timeout cannot post twice. Timing out is not the same as not
--    having posted, and a duplicate on a client's LinkedIn is the failure
--    that gets an agency fired.
--
-- 2. EVERY STATE CHANGE IS VERSION-CHECKED.
--    `UPDATE ... WHERE id = ? AND status = ? AND version = ?`. Two editors
--    acting at once must lose safely, and a double-click must not advance
--    the same request twice.
--
-- 3. RLS IS ON EVERYWHERE, AND anon GETS NOTHING.
--    See the ROW LEVEL SECURITY block below. This is the Week 2 lesson,
--    applied to a different architecture and therefore applied more strictly.
-- ============================================================

create extension if not exists vector;
create extension if not exists pgcrypto;
-- Trigram similarity powers the cannibalisation check today. See the note on
-- published_index below for why there is no embedding vendor in the path yet.
create extension if not exists pg_trgm;

-- ------------------------------------------------------------
-- People. Roles are enforced in the route handlers; the column is here so
-- an approval can name a person and survive them leaving.
-- ------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text not null,
  role          text not null default 'manager',  -- manager | editor | admin
  password_hash text,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 1. Content requests — the unit of work
-- ------------------------------------------------------------
create table if not exists public.content_requests (
  id                       uuid primary key default gen_random_uuid(),
  -- UNIQUE is what makes intake idempotent. A replayed submit returns the
  -- SAME request; it does not create a second one for someone to choose between.
  idempotency_key          text unique not null,
  idea                     text not null,
  audience                 text not null,
  goal                     text not null,
  channels                 text[] not null default '{}',
  keyword_hint             text,
  tone                     text,
  scheduled_for            timestamptz,
  publish_to_x             boolean not null default false,  -- $0.20/post: opt in per request
  status                   text not null default 'draft',
  version                  integer not null default 1,
  requester_id             uuid not null references public.users(id),
  -- Set at intake when the published-content index finds a near-duplicate.
  -- The system deciding NOT to run is the cheapest cost control it has.
  cannibalisation_match_id uuid,
  cannibalisation_score    numeric(5,4),
  -- Per-section word band, DERIVED from the competing articles we scraped
  -- (decision B-5). Falls back to 700-800 below 3 comparables, and which
  -- one applied is recorded so the evidence bundle can say so.
  section_target_min       integer,
  section_target_max       integer,
  section_target_source    text,          -- measured | fallback
  cost_usd                 numeric(10,4) not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists content_requests_status_idx on public.content_requests (status, updated_at desc);

-- ------------------------------------------------------------
-- 2. Sources — we own the bytes, because the approver must be able to read them
-- ------------------------------------------------------------
create table if not exists public.sources (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.content_requests(id) on delete cascade,
  submitted_url   text not null,
  final_url       text,                       -- metadata.url AFTER redirects
  provider        text not null,              -- firecrawl | web_fetch | manual
  http_status     integer,
  -- ok | paywalled | robots_denied | boilerplate | too_large | failed
  -- A source that quietly vanishes is worse than one that visibly failed.
  fetch_status    text not null,
  failure_reason  text,
  content_hash    text not null,
  body_markdown   text,
  body_expires_at timestamptz,                -- provenance outlives the mirror
  title           text,
  author          text,
  published_at    timestamptz,
  language        text,
  -- Parsed heading structure: [{heading, level, words}]. Decision B-5 derives
  -- the article's per-section depth band from what competitors actually do,
  -- so the shape of their sections has to survive the scrape.
  section_profile jsonb not null default '[]'::jsonb,
  -- Scraped pages are untrusted content that reaches a prompt and ends up
  -- published. A flagged source is excluded from the excerpt pool entirely.
  injection_flags jsonb not null default '[]'::jsonb,
  quarantined     boolean not null default false,
  relevance_score integer,
  authority_score integer,
  is_comparable   boolean not null default false,  -- a competing article, for B-5
  created_at      timestamptz not null default now(),
  unique (request_id, content_hash)
);

-- ------------------------------------------------------------
-- 3. Excerpts — citations point at a SPAN, not a document
-- ------------------------------------------------------------
create table if not exists public.excerpts (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references public.sources(id) on delete cascade,
  label            text not null,             -- 'S3P7'
  text             text not null,
  char_start       integer not null,
  char_end         integer not null,
  selected         boolean not null default false,
  selection_reason text
);
create index if not exists excerpts_source_idx on public.excerpts (source_id);

-- ------------------------------------------------------------
-- 4. Angles — three OUTLINES, not three articles
-- ------------------------------------------------------------
create table if not exists public.angles (
  id                     uuid primary key default gen_random_uuid(),
  request_id             uuid not null references public.content_requests(id) on delete cascade,
  ord                    integer not null,
  title                  text not null,
  thesis                 text not null,
  outline                jsonb not null default '[]'::jsonb,
  primary_keyword        text,
  secondary_keywords     text[],
  -- topical | supporting. Ahrefs: target TOPICAL long-tails. Writing a whole
  -- article against a SUPPORTING long-tail is the thin-content mistake the
  -- cannibalisation check exists to catch, so it is flagged here at planning
  -- time rather than after a 3,000-word draft has been paid for.
  keyword_class          text,
  supporting_excerpt_ids uuid[] not null default '{}',
  selected_by            uuid references public.users(id),
  selected_at            timestamptz,
  unique (request_id, ord)
);

-- ------------------------------------------------------------
-- 5. Assets — article + 3 channels, every revision retained
-- ------------------------------------------------------------
create table if not exists public.assets (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references public.content_requests(id) on delete cascade,
  kind                  text not null,       -- article | linkedin | x | newsletter
  revision              integer not null,
  parent_revision       integer,
  body                  text not null,
  -- Article only. Sections are stored separately from the body so regenerating
  -- one leaves the others BYTE-IDENTICAL, which is asserted by a test.
  sections              jsonb not null default '[]'::jsonb,
  subject_line          text,                -- newsletter
  image_slot            jsonb,               -- {placement, alt, brief, url?, provenance?}
  origin                text not null,       -- generate | auto_revise | human_edit | revert
  trigger_evaluation_id uuid,
  model                 text,
  prompt_version        text,
  tokens_in             integer,
  tokens_out            integer,
  cache_read_tokens     integer,
  cost_usd              numeric(10,4),
  created_by            uuid references public.users(id),
  created_at            timestamptz not null default now(),
  unique (request_id, kind, revision)
);

-- ------------------------------------------------------------
-- 6. Claims — the table that makes the whole thing auditable.
--    "Where did this statistic come from?" is one query, six months later.
-- ------------------------------------------------------------
create table if not exists public.claims (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  span_start integer,
  span_end   integer,
  text       text not null,
  status     text not null,                  -- supported | unsupported | waived
  excerpt_id uuid references public.excerpts(id),
  checker    text not null                   -- deterministic | judge
);
create index if not exists claims_asset_idx on public.claims (asset_id, status);

-- ------------------------------------------------------------
-- 7. Evaluations — per criterion, with evidence and a required action.
--    A bare number cannot drive a targeted revision.
-- ------------------------------------------------------------
create table if not exists public.evaluations (
  id              uuid primary key default gen_random_uuid(),
  asset_id        uuid not null references public.assets(id) on delete cascade,
  tier            integer not null,          -- 0 deterministic | 1 model judge
  criterion       text not null,
  score           integer,
  verdict         text,                      -- pass | revise | fail
  evidence        text,
  required_action text,
  model           text,
  schema_version  integer,
  cost_usd        numeric(10,4) not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists evaluations_asset_idx on public.evaluations (asset_id, tier);

-- ------------------------------------------------------------
-- 8. Flags — blocking flags make the approve endpoint REFUSE
-- ------------------------------------------------------------
create table if not exists public.flags (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.content_requests(id) on delete cascade,
  asset_kind    text,
  code          text not null,
  severity      text not null,               -- blocking | advisory
  message       text not null,
  span_start    integer,
  span_end      integer,
  status        text not null default 'open',-- open | resolved | waived
  waiver_reason text,
  waived_by     uuid references public.users(id),
  waived_at     timestamptz,
  created_at    timestamptz not null default now(),
  -- An unexplained waiver is indistinguishable from clicking through a
  -- warning, which is exactly what the gate exists to prevent. The route
  -- checks this too; the constraint is here because routes get refactored.
  constraint waiver_needs_reason
    check (status <> 'waived' or (waiver_reason is not null and length(btrim(waiver_reason)) > 0))
);
create index if not exists flags_request_idx on public.flags (request_id, status, severity);

-- ------------------------------------------------------------
-- 9. Approvals — what makes "a human approved it" mean something
-- ------------------------------------------------------------
create table if not exists public.approvals (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.content_requests(id) on delete cascade,
  asset_kind     text not null,
  actor_id       uuid not null references public.users(id),
  decision       text not null,              -- approved | changes_requested | rejected
  note           text,
  -- A hash of the evidence bundle that was ON SCREEN. This is what turns
  -- "someone clicked approve" into "a named person reviewed this material" —
  -- the EU AI Act Art. 50 standard of a check that is substantive rather
  -- than cursory. It is also what makes the six-month-later audit answerable.
  evidence_hash  text not null,
  -- The exact revision approved. Comparing this to the current revision is
  -- how "any edit voids the approval" is enforced — one comparison.
  asset_revision integer not null,
  solo_override  boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 10. Publish queue — the queue is the product, connectors are adapters
-- ------------------------------------------------------------
create table if not exists public.publish_queue (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references public.content_requests(id) on delete cascade,
  channel             text not null,          -- linkedin | x | newsletter
  asset_revision      integer not null,
  payload             jsonb not null,
  due_at              timestamptz not null,
  -- queued | claimed | sent | blocked | failed | queued_manual
  -- `blocked` is what a channel with no credentials records. NEVER `sent`.
  -- An honest failure beats a false success.
  state               text not null default 'queued',
  attempts            integer not null default 0,
  claimed_at          timestamptz,
  provider_message_id text,
  error_code          text,
  last_error_at       timestamptz,
  -- UNIQUE. The single thing standing between a provider timeout and a
  -- duplicate post on a client's channel.
  idempotency_key     text unique not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists publish_queue_due_idx on public.publish_queue (state, due_at);

-- ------------------------------------------------------------
-- 11. Notifications — same idempotency discipline as publishing.
--     A retry must not email the editor twice.
-- ------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid references public.content_requests(id) on delete cascade,
  kind         text not null,                -- angles_ready | needs_review | approved | ...
  -- One claim per (request, kind). The UNIQUE below is what stops a retried
  -- pipeline step emailing the editor twice.
  recipient    text,
  -- Which lane actually served it. n8n is primary and fans out to email plus
  -- the two Discord channels; resend_fallback is the degraded path that still
  -- reaches the person who has to act when n8n is unreachable.
  lane         text not null default 'n8n',  -- n8n | resend_fallback | none
  -- pending is written when the row is CLAIMED, before anything is emitted,
  -- and is replaced by the real outcome. A process that dies mid-emit
  -- therefore leaves a visible loose end rather than a row claiming the
  -- editor was told.
  state        text not null default 'pending',
  -- pending | sent | degraded | failed | skipped_not_configured
  error_code   text,
  created_at   timestamptz not null default now(),
  unique (request_id, kind)
);

-- ------------------------------------------------------------
-- 12. Published content index — OUR articles only.
--     Internal links and the cannibalisation check. Not the request's sources:
--     embedding material you fetched ten seconds ago and will use in full is
--     cost without benefit.
--
--     NOTE ON THE EMBEDDING COLUMN. Anthropic has no embeddings endpoint, and
--     adding a second model vendor purely to compare two short strings is not
--     a trade worth making at this size. So the cannibalisation check runs on
--     pg_trgm similarity over title + summary + keyword, which needs no vendor
--     and works today. The vector column and its HNSW index are provisioned
--     for the upgrade: when an embedding provider is added, backfill this
--     column and switch match_published to the <=> operator. Ordering by the
--     distance operator rather than the computed similarity is what keeps the
--     index in play — that is the easy thing to get wrong.
-- ------------------------------------------------------------
create table if not exists public.published_index (
  id              uuid primary key default gen_random_uuid(),
  url             text unique not null,
  title           text not null,
  summary         text,
  primary_keyword text,
  is_cornerstone  boolean not null default false,
  published_at    timestamptz,
  embedding       vector(1536)
);
create index if not exists published_index_embedding_idx
  on public.published_index using hnsw (embedding vector_cosine_ops);
create index if not exists published_index_trgm_idx
  on public.published_index using gin ((title || ' ' || coalesce(summary,'')) gin_trgm_ops);

-- The cannibalisation check, as it actually runs today.
create or replace function public.match_published_text(
  q text, match_threshold float default 0.35, match_count int default 3
) returns table (id uuid, url text, title text, similarity float)
language sql stable as $$
  select p.id, p.url, p.title,
         similarity(p.title || ' ' || coalesce(p.summary,'') || ' ' ||
                    coalesce(p.primary_keyword,''), q) as similarity
    from public.published_index p
   where similarity(p.title || ' ' || coalesce(p.summary,'') || ' ' ||
                    coalesce(p.primary_keyword,''), q) > match_threshold
   order by similarity desc
   limit match_count;
$$;

revoke all on function public.match_published_text(text, float, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 13. Events — the audit log.
--     n8n prunes its own execution history after 14 days by default and does
--     not save manual executions at all, so the n8n list is a debugging
--     convenience. THIS is the audit log.
-- ------------------------------------------------------------
create table if not exists public.events (
  id             bigserial primary key,
  correlation_id uuid not null,
  request_id     uuid,
  actor_id       uuid,
  stage          text not null,
  outcome        text not null,               -- ok | failed | skipped | blocked
  latency_ms     integer,
  cost_usd       numeric(10,4),
  detail         jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists events_request_idx on public.events (request_id, created_at desc);
create index if not exists events_correlation_idx on public.events (correlation_id);

-- ============================================================
-- ROW LEVEL SECURITY
--
-- Carried forward from Week 2, and applied MORE strictly because the
-- architecture changed.
--
-- Week 2 shipped a publishable key to the browser and let the dashboard read
-- Postgres directly, so it needed `for select to anon` policies on the tables
-- the dashboard rendered. THIS app never queries Postgres from the browser —
-- every read and write goes through a Next.js route handler over DATABASE_URL.
--
-- So `anon` needs nothing, and gets nothing: RLS is enabled on every table
-- and NO permissive policy exists for it anywhere in this file. With RLS on
-- and no policy, the role gets zero rows. Deny by default.
--
-- This matters even though the app does not use the Data API, because a
-- Supabase project EXPOSES PostgREST by default and the publishable key is
-- public by design. A table without RLS in a Supabase project is not a
-- private table — it is an open API endpoint. That is the failure this block
-- exists to prevent, and it is the one that actually bites people.
--
-- DATABASE_URL connects as a privileged role and therefore bypasses RLS.
-- That is intended: the app IS the authorisation layer, enforcing ownership,
-- separation of duties and state in the route handlers. RLS here is defence
-- in depth against a door the app does not use but Supabase leaves open.
--
-- Belt and braces: also revoke the PostgREST roles' table privileges, so the
-- Data API fails at GRANT level before RLS is ever consulted.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'content_requests', 'sources', 'excerpts', 'angles', 'assets',
    'claims', 'evaluations', 'flags', 'approvals', 'publish_queue',
    'notifications', 'published_index', 'events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- Force RLS so even a table owner is subject to it, closing the gap where
    -- a future migration run by the owner role would silently bypass policy.
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Deliberately empty: there is not one `create policy ... to anon` in this
-- file. If a future change needs browser-side reads, add the narrowest
-- possible policy HERE, with a comment saying which view needs it and why —
-- do not widen an existing one.

revoke all on schema public from anon, authenticated;
