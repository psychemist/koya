create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  role          text not null check (role in ('support_agent','admin')),
  password_hash text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.evaluations (
  id                uuid primary key default gen_random_uuid(),
  eval_run_id       uuid not null,
  scenario_key      text not null,
  scenario_title    text not null,
  expected_behavior text not null,
  actual_behavior   text not null,
  passed            boolean not null,
  notes             text,
  source            text not null check (source in ('automated','manual')),
  conversation_id   uuid references public.conversations(id) on delete set null,
  model             text,
  cost_usd          numeric(10,5),
  latency_p50_ms    int,
  latency_p95_ms    int,
  created_by        uuid references public.users(id),
  created_at        timestamptz not null default now(),
  unique (eval_run_id, scenario_key)
);
