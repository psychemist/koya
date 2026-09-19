-- ============================================================
-- Koya Content Desk — migration 0006
--
-- Taking the revision loop off the HTTP request.
--
-- The generate route ran draft, adapt, evaluate and up to two revision
-- passes inside one request bounded by maxDuration = 300s. Measured against
-- that budget, the work does not fit and never did:
--
--     generate.draft    4 runs   avg 146s   max 218s
--     generate.adapt    4 runs   avg  19s   max  29s
--
-- Draft plus adapt averaged 165s and peaked at 247s. A revision pass is
-- another full-article generation, so it needs roughly another 146s. On the
-- run that exposed this there were ~53s left when reviseUntilClean started.
--
-- The failure was therefore deterministic, not unlucky: a draft the judge
-- passed clean never entered the loop and completed fine, and a draft with
-- blocking findings entered a pass that could not finish, the process was
-- killed, and the catch in the generate route could not unwind a status from
-- a process that no longer existed. The request sat at `evaluating`, which
-- no route accepts, with a complete draft nobody could approve.
--
-- So the loop moves onto the heartbeat, which is the only thing guaranteed
-- to run after a crash, and which already drives publishing.
--
-- These two columns are the only state that has to survive a tick boundary.
-- Everything else the loop needs is re-derived by the `evaluate()` call that
-- starts each tick: it resolves the previous run's flags before inserting
-- the current ones, so running it once per tick is idempotent and always
-- describes the assets that exist right now.
--
--   revise_passes           how many passes have been spent, against
--                           MAX_REVISIONS. Without it a resumed loop would
--                           restart at zero and could revise forever.
--   revise_discarded_worse  whether a pass was already thrown away by the
--                           monotonicity guard, so the notification still
--                           says so after a resume.
--
-- Both are reset when generation starts, never read outside the loop.
--
-- Safe to re-run.
-- ============================================================

alter table public.content_requests
  add column if not exists revise_passes integer not null default 0;
alter table public.content_requests
  add column if not exists revise_discarded_worse boolean not null default false;

comment on column public.content_requests.revise_passes is
  'Revision passes spent so far on the current generation, against '
  'MAX_REVISIONS. Survives a tick boundary so a resumed loop does not '
  'restart its budget at zero. Reset when generation starts.';

comment on column public.content_requests.revise_discarded_worse is
  'True once the monotonicity guard has thrown away a pass that scored worse '
  'than its parent. Carried across ticks so the notification still reports '
  'it after the loop resumes. Reset when generation starts.';
