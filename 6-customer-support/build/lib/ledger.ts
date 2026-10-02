import { one, query } from './db.ts';

/**
 * Money spent is money spent: the ledger outlives the conversation it paid
 * for (ON DELETE SET NULL), so the daily cap counts it even after a test or an
 * admin deletes the conversation.
 */
export async function recordSpend(provider: 'anthropic' | 'voyage', amountUsd: number, conversationId?: string | null, note?: string): Promise<void> {
  if (!(amountUsd > 0)) return;
  await query('insert into public.spend_ledger (provider, amount_usd, conversation_id, note) values ($1,$2,$3,$4)',
    [provider, amountUsd, conversationId ?? null, note ?? null]);
}

const SINCE_UTC_MIDNIGHT = `created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/** Today's Claude spend as a subquery, so a turn can read it in the same round trip as its other checks. */
export const SPENT_TODAY_SQL = `(select coalesce(sum(amount_usd), 0)::text from public.spend_ledger
  where provider = 'anthropic' and ${SINCE_UTC_MIDNIGHT})`;

/** The UTC day is computed in SQL, so the service clock and its timezone cannot move the boundary. */
export async function spentToday(provider: 'anthropic' | 'voyage'): Promise<number> {
  const r = await one<{ total: string }>(
    `select coalesce(sum(amount_usd), 0)::text as total from public.spend_ledger where provider = $1 and ${SINCE_UTC_MIDNIGHT}`, [provider]);
  return Number(r?.total ?? 0);
}
