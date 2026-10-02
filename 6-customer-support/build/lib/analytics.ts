import { one, query } from './db.ts';

/** Real traffic only: eval runs are graded by the harness and would swamp every number here. */
const REAL = `c.channel in ('voice_web', 'voice_phone', 'web_text')`;

export type Analytics = {
  days: number;
  totals: { conversations: number; answered_pct: number | null; escalated_pct: number | null; callbacks_booked: number;
    p50_ms: number | null; p95_ms: number | null; spend_usd: number; feedback: number; helped_pct: number | null };
  perDay: { day: string; conversations: number }[];
  outcomes: { outcome: string; conversations: number }[];
  channels: { channel: string; conversations: number; p50_ms: number | null; p95_ms: number | null; cost_usd: number }[];
  tools: { tool: string; ok: number; failed: number; avg_ms: number | null }[];
  bookings: { booked: number; failed: number; moved: number };
};

/**
 * The console's analytics, from the records the agent and the MCP server write, over the last `days` days. Every
 * number is a count or a percentile of stored rows; nothing is estimated or generated.
 */
export async function analytics(days = 30): Promise<Analytics> {
  const since = `now() - make_interval(days => ${Math.max(1, Math.min(365, Math.floor(days)))})`;
  const [totals, perDay, outcomes, channels, tools, bookings, feedback] = await Promise.all([
    one<any>(`select count(*)::int as conversations,
        round(100.0 * count(*) filter (where final_status in ('resolved', 'clarified')) / nullif(count(*) filter (where final_status is not null), 0))::int as answered_pct,
        round(100.0 * count(*) filter (where final_status = 'escalated') / nullif(count(*) filter (where final_status is not null), 0))::int as escalated_pct,
        coalesce(sum(cost_usd), 0)::float8 as spend_usd
      from public.conversations c where ${REAL} and c.started_at > ${since}`),
    query<any>(`select to_char(d, 'YYYY-MM-DD') as day, coalesce(n, 0)::int as conversations
      from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
      left join (select date_trunc('day', started_at) as day, count(*) as n from public.conversations c where ${REAL} group by 1) x on x.day = d
      order by d`),
    query<any>(`select coalesce(final_status, 'open') as outcome, count(*)::int as conversations
      from public.conversations c where ${REAL} and c.started_at > ${since} group by 1 order by 2 desc`),
    query<any>(`select c.channel, count(distinct c.id)::int as conversations,
        percentile_cont(0.5) within group (order by t.latency_ms)::int as p50_ms,
        percentile_cont(0.95) within group (order by t.latency_ms)::int as p95_ms,
        coalesce((select sum(cost_usd) from public.conversations x where x.channel = c.channel and x.started_at > ${since}), 0)::float8 as cost_usd
      from public.conversations c left join public.conversation_turns t on t.conversation_id = c.id and t.status = 'ok'
      where ${REAL} and c.started_at > ${since} group by 1 order by 2 desc`),
    query<any>(`select t.tool_name as tool, count(*) filter (where t.status = 'ok')::int as ok,
        count(*) filter (where t.status in ('error', 'denied'))::int as failed, round(avg(t.duration_ms))::int as avg_ms
      from public.tool_calls t join public.conversations c on c.id = t.conversation_id
      where ${REAL} and t.created_at > ${since} group by 1 order by 2 desc`),
    one<any>(`select count(*) filter (where e.booking_status = 'booked')::int as booked,
        count(*) filter (where e.booking_status = 'failed')::int as failed,
        (select count(*)::int from public.conversation_events v join public.conversations c on c.id = v.conversation_id
          where ${REAL} and v.event_type = 'note' and v.summary like 'Callback moved to%' and v.created_at > ${since}) as moved
      from public.escalations e join public.conversations c on c.id = e.conversation_id where ${REAL} and e.created_at > ${since}`),
    // The feedback table arrives with migration 0010; before it exists the page still loads, with no feedback figures.
    one<any>(`select count(*)::int as n, round(100.0 * count(*) filter (where rating = 'good') / nullif(count(*), 0))::int as helped_pct
      from public.feedback where created_at > ${since}`).catch(() => ({ n: 0, helped_pct: null })),
  ]);
  const all = await one<any>(`select percentile_cont(0.5) within group (order by t.latency_ms)::int as p50,
      percentile_cont(0.95) within group (order by t.latency_ms)::int as p95
    from public.conversation_turns t join public.conversations c on c.id = t.conversation_id
    where ${REAL} and t.status = 'ok' and t.created_at > ${since}`);
  return {
    days,
    totals: { conversations: totals.conversations, answered_pct: totals.answered_pct, escalated_pct: totals.escalated_pct,
      callbacks_booked: bookings.booked, p50_ms: all?.p50 ?? null, p95_ms: all?.p95 ?? null, spend_usd: totals.spend_usd,
      feedback: feedback?.n ?? 0, helped_pct: feedback?.helped_pct ?? null },
    perDay, outcomes, channels, tools, bookings,
  };
}
