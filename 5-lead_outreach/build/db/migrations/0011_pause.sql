-- ============================================================
-- A run can be parked by the person who started it.
--
-- Everything a run produces is already written as it goes: the ICP before the
-- first paid call, each company as it is discovered, each page as it is read,
-- each verdict as it is reached. So stopping one costs no results. What cannot
-- be saved is the agent's conversation, which lives in the worker process and
-- has no session to persist, so resuming starts a fresh session that reads the
-- stored rows back through get_run_state. That costs one context rebuild and
-- re-does no discovery, no scraping and no judging.
--
-- Parking, not cancelling. The run keeps its id, its budgets, its ledger and
-- its audit trail, which is the same shape the clarification park already has:
-- the claim query skips it and the budget hook refuses to spend on it.
--
-- `paused_by` is who pulled the handle, because a shared budget means a run
-- somebody else started can be stopped, and "why did this stop" should be
-- answerable without reading the worker log.
-- ============================================================

alter table public.runs
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.users(id) on delete set null;

comment on column public.runs.paused_at is
  'Set while a person has parked the run. The claim query skips it and the budget hook '
  'refuses every paid tool. Cleared on resume, which also requeues the run.';
