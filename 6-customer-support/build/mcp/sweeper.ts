import { query } from '../lib/db.ts';
import { dispatchNotification, MAX_ATTEMPTS } from '../lib/escalations/dispatch.ts';

/**
 * Retries outbox rows the first attempt left behind: a retry after both lanes
 * failed, or a row stuck in 'sending' because a worker died between its claim
 * and its send. A row is stale once its claim is over 60 seconds old. `now` is
 * a parameter so tests can move past the window without sleeping.
 */
export async function sweepNotifications(now: Date = new Date()): Promise<number> {
  await query(`update public.notifications set status = 'retry'
    where status = 'sending' and claimed_at < $1::timestamptz - interval '60 seconds' and attempts < $2`, [now.toISOString(), MAX_ATTEMPTS]);
  await query(`update public.notifications set status = 'failed', last_error = coalesce(last_error, 'abandoned mid-send')
    where status = 'sending' and claimed_at < $1::timestamptz - interval '60 seconds' and attempts >= $2`, [now.toISOString(), MAX_ATTEMPTS]);
  // A held alert whose caller had their chance to settle a time is sent as it stands.
  await query(`update public.notifications set status = 'retry', claimed_at = null
    where status = 'held' and alert_after <= $1::timestamptz`, [now.toISOString()]);
  const due = await query<{ id: string; channel: string }>(
    `select n.id, c.channel from public.notifications n
     join public.escalations e on e.id = n.escalation_id join public.conversations c on c.id = e.conversation_id
     where n.status in ('pending', 'retry') and (n.claimed_at is null or n.claimed_at < $1::timestamptz - interval '60 seconds')
     order by n.created_at limit 20`, [now.toISOString()]);
  for (const d of due) await dispatchNotification(d.id, { dryRun: d.channel === 'eval' });
  return due.length;
}

export function startSweeper(everyMs = 60_000): () => void {
  const t = setInterval(() => { sweepNotifications().catch((e) => console.error(JSON.stringify({ level: 'error', at: 'sweeper', message: e.message }))); }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
