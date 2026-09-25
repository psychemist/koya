-- ============================================================
-- The reviewer's decision, applied to the lead rather than parked beside it.
--
-- `human_status` was written, rendered and exported, and changed nothing else.
-- Accepting a needs_review lead did not qualify it, did not count toward the
-- target, produced no drafts, and never reached a later run. The one review
-- action the spec names was a dead end, and a control that changes nothing is
-- worse than no control because the reviewer believes they have acted.
--
-- The decision now moves `qualification_status` itself, which is what
-- `runStats`, `finish_run` and the delivered list already read.
--
-- `agent_verdict` holds what the agent said before the override. A system
-- whose whole value is an audit trail must not lose the judgement it is
-- auditing, so the override is recorded as an override rather than as an
-- erasure. It stays NULL on every lead no human has touched.
-- ============================================================

alter table public.leads
  add column if not exists agent_verdict    text,
  add column if not exists human_decided_at timestamptz;

comment on column public.leads.agent_verdict is
  'The qualification_status the agent wrote, kept only when a human overrode it.';
