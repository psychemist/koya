-- ============================================================
-- Koya Content Desk — migration 0004
--
-- Uploaded material, and the option to write from nothing else.
--
-- Two facts drive this. Research discovery is a search, so what it finds is
-- whatever is public and ranks well, and a good deal of the material worth
-- writing from is neither: a fee note, a scanned report, an internal deck, a
-- PDF somebody was emailed. Second, an agency writing for a client is usually
-- working FROM that material rather than from the open web, and mixing in
-- eight discovered competitor articles is not neutral. It changes what gets
-- written.
--
-- An attachment becomes an ordinary row in `sources`, with provider `upload`.
-- That is the point of doing it this way: excerpts, citation labels, the
-- grounding check, quarantine and the evidence bundle all work on it unchanged,
-- because as far as everything downstream is concerned it is a source that
-- happened to arrive by a different route.
--
-- Safe to re-run.
-- ============================================================

-- Write from the supplied material only: no search, no competitor discovery.
--
-- It has a real cost and the UI says so. Decision B-5 derives the per-section
-- word band from comparable articles, and with no discovery there usually are
-- none, so the band falls back to 700-800 and records that it did. Choosing
-- fidelity to the supplied material over a measured depth target is a
-- reasonable trade; making it silently is not.
alter table public.content_requests
  add column if not exists sources_only boolean not null default false;

-- What the file was called when somebody uploaded it. `submitted_url` carries
-- a synthetic upload: reference so the NOT NULL and the unique key still hold,
-- and that is unreadable on screen.
alter table public.sources
  add column if not exists original_filename text;

-- Bytes, for the rail and for the admin page's cost view. An OCR pass is
-- charged per page and this is the closest proxy stored.
alter table public.sources
  add column if not exists byte_size integer;

comment on column public.content_requests.sources_only is
  'Skip discovery and write only from supplied URLs and uploads. The section '
  'depth band falls back to 700-800 when this leaves fewer than 3 comparables.';
