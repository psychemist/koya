-- ============================================================
-- Koya Content Desk — migration 0005
--
-- Closing the loop on a manually posted item.
--
-- The queue already has an honest answer for a channel with no credentials:
-- `queued_manual`, copy-ready text, and a one-click composer link. What it
-- did not have was any way back. Once somebody actually went to LinkedIn or
-- X and pressed Post themselves, the row sat at `queued_manual` forever,
-- indistinguishable from one nobody had touched yet. The queue page could
-- not tell "still needs posting" from "already posted by hand", and neither
-- could the person looking at it a week later.
--
-- `confirmed_by` and `confirmed_at` record that a NAMED PERSON asserted the
-- post went out, which is a different and weaker claim than a provider
-- confirming it: no message id, no way to verify it independently, but a
-- real fact worth keeping rather than a permanent unknown. The new state
-- value `sent_manually`, used in application code, says as much wherever
-- this is shown, so it never reads as an automated success.
--
-- Safe to re-run.
-- ============================================================

alter table public.publish_queue
  add column if not exists confirmed_by uuid references public.users(id);
alter table public.publish_queue
  add column if not exists confirmed_at timestamptz;

comment on column public.publish_queue.confirmed_by is
  'Set only when a person marks a manually-posted row as sent by hand. Null '
  'for every row a provider actually confirmed.';
