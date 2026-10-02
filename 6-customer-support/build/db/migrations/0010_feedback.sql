-- What callers thought of a call or a chat, asked once it ends. A web call is known to the page by its Vapi call
-- id and a chat by its conversation; one answer per call or chat, which a caller may change.
create table if not exists public.feedback (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null check (channel in ('voice_web', 'web_text')),
  vapi_call_id    text,
  conversation_id uuid references public.conversations(id) on delete cascade,
  caller_mode     text check (caller_mode in ('customer', 'guest')),
  customer_id     text references public.customers(customer_id),
  rating          text not null check (rating in ('good', 'bad')),
  comment         text check (length(comment) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (vapi_call_id is not null or conversation_id is not null)
);
create unique index if not exists feedback_one_per_call on public.feedback (vapi_call_id) where vapi_call_id is not null;
create unique index if not exists feedback_one_per_chat on public.feedback (conversation_id) where channel = 'web_text';
create index if not exists feedback_created on public.feedback (created_at desc);
