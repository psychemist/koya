-- ============================================================
-- Koya Content Desk — migration 0002
--
-- Newsletter subscribers, and the defect that made this necessary.
--
-- `app/api/requests/[id]/approve/route.ts` built its publish payload with
-- `recipients: r.newsletter_recipients ?? []`, reading a column that has never
-- existed on `content_requests`. Postgres does not return it, `pg` gives
-- `undefined`, the `??` turns that into an empty array, and the connector
-- refuses with `newsletter_no_recipients`.
--
-- So the newsletter lane could not have delivered a single email, and nothing
-- said so until the queue row was read. The `??` is what hid it: a default
-- written for a missing VALUE quietly absorbed a missing COLUMN.
--
-- A subscriber list is the right home for this anyway. Recipients are a
-- property of the list, not of one request: copying them onto every request
-- would mean an unsubscribe only took effect for requests raised afterwards.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.newsletter_subscribers (
  id           uuid primary key default gen_random_uuid(),
  -- Stored lower-cased by the route. Two rows differing only in case are one
  -- person who then gets two copies of every send.
  email        text unique not null,
  name         text,
  -- active | unsubscribed. A row is never deleted on unsubscribe: re-adding
  -- somebody who has asked to be left alone is the one mistake in this table
  -- that carries a legal consequence, and it needs the record to prevent it.
  status       text not null default 'active',
  source       text,                         -- how they got on the list
  added_by     uuid references public.users(id),
  created_at   timestamptz not null default now(),
  unsubscribed_at timestamptz,
  constraint subscriber_status check (status in ('active', 'unsubscribed'))
);
create index if not exists newsletter_subscribers_status_idx
  on public.newsletter_subscribers (status, created_at desc);

-- Same posture as every other table: RLS on, forced, and anon gets nothing.
-- A Supabase project exposes PostgREST by default, so a table without this is
-- not a private table, it is an open API endpoint. A subscriber list read out
-- of one is a personal data breach rather than an inconvenience.
alter table public.newsletter_subscribers enable row level security;
alter table public.newsletter_subscribers force row level security;
revoke all on public.newsletter_subscribers from anon, authenticated;
