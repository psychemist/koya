-- ============================================================
-- Runtime records. Three ideas:
-- 1. ONE ROW PER REAL THING. A call is one conversation however many
--    webhooks arrive; a request is one ticket however many times it is said.
-- 2. THE WRAPPER LOGS, NOT THE AGENT. tool_calls rows are written by the
--    MCP server around every handler, so a crash still leaves a record.
-- 3. NOTIFICATION IS AN OUTBOX. The row that says "tell the team" is
--    committed with the escalation, so a crash between them cannot lose it.
-- ============================================================
create table if not exists public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  vapi_call_id         text unique,
  channel              text not null check (channel in ('voice_web','voice_phone','web_text','eval','mcp_direct')),
  caller_identifier    text,                 -- 'web', masked phone '***1234', or eval run id
  verified_customer_id text references public.customers(customer_id),
  model                text,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  ended_reason         text,
  final_status         text check (final_status in ('resolved','clarified','ticketed','escalated','declined','abandoned','failed')),
  summary              text,
  turn_count           int not null default 0,
  cost_usd             numeric(10,5) not null default 0,
  identity_failures    int not null default 0,
  eval_run_id          uuid
);
create index if not exists conversations_started on public.conversations (started_at desc);

create table if not exists public.conversation_turns (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  seq                int not null,
  user_transcript    text not null,
  assistant_response text not null,
  answer_type        text not null check (answer_type in ('answer','clarify','escalate','decline')),
  confidence_note    text,
  citations          text[] not null default '{}',
  status             text not null check (status in ('ok','fallback','failed','interrupted','capacity')),
  gate_result        jsonb not null default '{}'::jsonb,   -- { attempts, violations[] }
  latency_ms         int,
  cost_usd           numeric(10,5) not null default 0,
  model              text,
  created_at         timestamptz not null default now(),
  unique (conversation_id, seq)
);

create table if not exists public.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,  -- null only when resolution itself failed
  tool_name       text not null,
  purpose         text,
  input_summary   jsonb not null default '{}'::jsonb,
  result_summary  jsonb,
  status          text not null check (status in ('started','ok','error','denied')),
  error_code      text,
  error_message   text,
  duration_ms     int,
  created_at      timestamptz not null default now()
);
create index if not exists tool_calls_conversation on public.tool_calls (conversation_id, created_at);

create table if not exists public.retrieval_logs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  tool_call_id     uuid references public.tool_calls(id) on delete set null,
  query            text not null,
  chunk_ids        text[] not null,
  source_titles    text[] not null,
  source_summaries text[] not null,
  scores           jsonb not null,           -- [{ id, similarity, fts_rank, rrf, grounded }]
  grounded         boolean not null,
  degraded         boolean not null default false,
  created_at       timestamptz not null default now()
);

create sequence if not exists public.ticket_ref_seq;
create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ticket_ref      text not null unique default ('RP-T-' || lpad(nextval('public.ticket_ref_seq')::text, 6, '0')),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  customer_id     text references public.customers(customer_id),
  transaction_id  text references public.transactions(transaction_id),
  category        text not null check (category in ('payment','payout','invoice','account','compliance','dispute','other')),
  priority        text not null check (priority in ('low','normal','high','urgent')),
  summary         text not null check (length(summary) between 10 and 500),
  status          text not null default 'open' check (status in ('open','in_progress','closed')),
  dedupe_key      text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists support_tickets_open_dedupe
  on public.support_tickets (dedupe_key) where status <> 'closed';

create sequence if not exists public.escalation_ref_seq;
create table if not exists public.escalations (
  id                  uuid primary key default gen_random_uuid(),
  escalation_ref      text not null unique default ('RP-E-' || lpad(nextval('public.escalation_ref_seq')::text, 6, '0')),
  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  ticket_id           uuid references public.support_tickets(id),
  customer_id         text references public.customers(customer_id),
  user_name           text not null,
  user_email          text not null check (user_email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  category            text not null check (category in ('compliance','account','dispute','payment','other')),
  reason              text not null,
  preferred_time_text text,
  caller_timezone     text,
  requested_slot_at   timestamptz,
  appointment_at      timestamptz,
  call_booked         boolean not null default false,
  calendar_event_id   text,
  booking_status      text not null default 'not_requested'
                        check (booking_status in ('not_requested','pending','booked','slot_unavailable','failed','dry_run')),
  notify_status       text not null default 'pending' check (notify_status in ('pending','sent','fallback_sent','failed')),
  status              text not null default 'open' check (status in ('open','in_progress','closed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists escalations_one_open_per_conversation
  on public.escalations (conversation_id) where status <> 'closed';

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  escalation_id uuid not null references public.escalations(id) on delete cascade,
  slot_key      text not null,            -- ISO slot start, or 'none' for an alert with no booking
  status        text not null default 'pending' check (status in ('pending','sending','retry','sent','fallback_sent','failed')),
  attempts      int not null default 0,
  last_error    text,
  claimed_at    timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (escalation_id, slot_key)
);

create table if not exists public.conversation_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  event_type      text not null check (event_type in ('path_chosen','clarification_requested','identity_verified',
                    'identity_failed','escalation_triggered','declined','caller_frustrated','note',
                    'session_opened','session_recovered','session_closed','interrupted','capacity_refused')),
  source          text not null default 'agent' check (source in ('agent','system')),
  summary         text not null check (length(summary) <= 500),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists public.spend_ledger (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('anthropic','voyage')),
  amount_usd      numeric(10,6) not null check (amount_usd >= 0),
  conversation_id uuid references public.conversations(id) on delete set null,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists spend_ledger_day on public.spend_ledger (provider, created_at);
