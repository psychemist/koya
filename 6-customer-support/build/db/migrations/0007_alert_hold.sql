-- One alert per escalation, not one per attempt. While the agent and the caller are still settling a
-- time (no time yet, or the time was taken), each create_escalation call makes a new outbox row, and
-- each row emailed the team. An unsettled row now waits (held) until alert_after; a newer attempt on
-- the same escalation supersedes it, so the team hears the outcome the call ended on.

alter table public.notifications add column if not exists alert_after timestamptz;

alter table public.notifications drop constraint if exists notifications_status_check;
alter table public.notifications add constraint notifications_status_check
  check (status in ('pending','sending','retry','held','superseded','sent','fallback_sent','failed'));
