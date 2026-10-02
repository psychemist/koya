-- How the caller came in on the support page. 'customer' means they signed in with their account email
-- and customer ID, and verified_customer_id was set from that sign-in rather than by lookup_customer;
-- 'guest' means knowledge-base answers only, with no account, transaction or payout lookups.
-- Null is a phone call, an eval or a direct MCP session, which keep the two-identifier flow.
alter table public.conversations
  add column if not exists caller_mode text check (caller_mode in ('customer', 'guest'));
