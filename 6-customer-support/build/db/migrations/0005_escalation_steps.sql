-- The escalation lane moved from one n8n call into three steps in code: a
-- Cal.com booking, a Discord post and the support email. Each step's result is
-- kept on the outbox row, so a retry redoes only what did not happen: a
-- callback is never booked twice and the team is never emailed twice.

alter table public.notifications
  add column if not exists booking_result text check (booking_result in ('booked', 'slot_taken', 'failed')),
  add column if not exists booking_uid    text,
  -- Best effort, one try: set once, never retried.
  add column if not exists discord_status text check (discord_status in ('sent', 'failed', 'skipped')),
  add column if not exists email_sent_at  timestamptz;
