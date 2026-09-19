-- ============================================================
-- Koya Content Desk — migration 0007
--
-- A claim for the tick itself.
--
-- Moving revision onto the heartbeat (0006) made the tick the only thing
-- that finishes a generation, and left the app unable to fire it: the sole
-- caller was an n8n schedule trigger, so with n8n down a request waited at
-- `evaluating` forever. That is the same dead end 0006 set out to remove,
-- reached from a different direction.
--
-- The app can now nudge the tick. That makes double-firing a real risk
-- rather than a theoretical one, because the nudge is reachable from every
-- open progress poller at once, and a tick can start a revision pass that
-- costs real money and runs for 146 seconds. Two ticks racing would not
-- corrupt anything — rows are claimed individually by status and by
-- FOR UPDATE SKIP LOCKED — but they would spend twice for no benefit.
--
-- ONE ROW, AND THE CLAIM IS THE RATE LIMIT.
--
--     update public.tick_state
--        set last_run_at = now()
--      where last_run_at < now() - interval '60 seconds'
--     returning last_run_at
--
-- Under READ COMMITTED this is atomic and needs no advisory lock. Two
-- concurrent callers both attempt the UPDATE; one takes the row lock and
-- commits, the other blocks, then re-evaluates the predicate against the
-- newly committed row, finds `last_run_at` is now recent, and updates
-- nothing. Exactly one caller gets a row back, and that caller owns the
-- tick. It is the same "UPDATE ... WHERE ... RETURNING as a claim" shape the
-- publish queue already uses, applied to a singleton.
--
-- `started_at` is separate from `last_run_at` so an operator can tell a tick
-- that is still running from one that finished, without inferring it from
-- the absence of events.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.tick_state (
  -- A singleton. The CHECK is what makes it one: a second insert cannot
  -- invent id=false, so there is exactly one row to contend on and no way
  -- for two callers to claim two different rows and both think they won.
  id           boolean primary key default true,
  last_run_at  timestamptz not null default to_timestamp(0),
  started_at   timestamptz,
  last_source  text,
  constraint tick_state_singleton check (id)
);

insert into public.tick_state (id) values (true) on conflict (id) do nothing;

comment on table public.tick_state is
  'One row. Claiming the tick is an UPDATE against last_run_at, which is '
  'both the rate limit and the mutual exclusion. See migration 0007.';
comment on column public.tick_state.last_run_at is
  'When the tick was last CLAIMED, not when it finished. Defaults to the '
  'epoch so the very first claim always succeeds.';
comment on column public.tick_state.last_source is
  'Which caller won the last claim — the n8n schedule or an in-app nudge. '
  'Operational only: it is how you tell a heartbeat that is actually '
  'running from one that only appears to be because people have pages open.';
