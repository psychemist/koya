-- ============================================================
-- The injection screen, cached by what it read.
--
-- The page cache stops a rerun paying Firecrawl twice, but the screen ran on
-- EVERY scrape call including a cache hit, so a cached page was free of
-- Firecrawl cost and not free: it still cost a model call. With thirty scrapes
-- a run and a global page cache, that is the one remaining per-page model cost
-- on work already done.
--
-- Keyed by content hash rather than URL, because the screen is a function of
-- the text. Two URLs serving identical bytes are one screening job, and a page
-- that changed gets a new hash and is screened again, which is the point.
-- ============================================================

create table if not exists public.screen_cache (
  content_hash     text primary key,
  summary          text not null,
  injection_flagged boolean not null,
  injection_reason text,
  usable           boolean not null,
  screened_at      timestamptz not null default now()
);

alter table public.screen_cache enable row level security;
