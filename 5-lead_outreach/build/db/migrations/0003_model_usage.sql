-- ============================================================
-- Per-model usage, captured from the agent's result message.
--
-- The design claims the skills and the system prompt form a stable cached
-- prefix across turns. That claim was unverifiable: nothing recorded
-- cache_read_input_tokens, so "the prefix is cached" rested on undocumented
-- default behaviour with no way to tell whether it held.
--
-- This is also the only per-model cost breakdown; runs.claude_cost_usd is a
-- single client-side estimate covering the whole loop.
-- ============================================================

alter table public.runs
  add column if not exists model_usage jsonb;
