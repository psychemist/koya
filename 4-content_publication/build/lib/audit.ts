import { query } from './db';
import { redact } from './sanitise';

export type Outcome = 'ok' | 'failed' | 'skipped' | 'blocked';

/**
 * Writes one row per step: correlation ID, stage, outcome, latency, cost.
 *
 * DEGRADES TO STDOUT IF THE DATABASE WRITE FAILS. The log that explains a
 * database outage must survive it — and an audit writer that can throw is a
 * second failure stacked on the first one you were trying to record.
 */
export async function event(e: {
  correlationId: string;
  requestId?: string | null;
  actorId?: string | null;
  stage: string;
  outcome: Outcome;
  latencyMs?: number;
  costUsd?: number;
  detail?: unknown;
}): Promise<void> {
  const detail = redact(e.detail);
  try {
    await query(
      `insert into public.events
         (correlation_id, request_id, actor_id, stage, outcome, latency_ms, cost_usd, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.correlationId, e.requestId ?? null, e.actorId ?? null,
        e.stage, e.outcome, e.latencyMs ?? null, e.costUsd ?? 0,
        detail === undefined ? null : JSON.stringify(detail),
      ],
    );
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', at: 'audit_degraded',
      reason: err instanceof Error ? err.message : String(err),
      event: { ...e, detail },
    }));
  }
}

/** Times a step and records it whichever way it ends. */
export async function tracked<T>(
  meta: { correlationId: string; requestId?: string | null; actorId?: string | null; stage: string },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    await event({ ...meta, outcome: 'ok', latencyMs: Date.now() - started });
    return out;
  } catch (e) {
    await event({
      ...meta, outcome: 'failed', latencyMs: Date.now() - started,
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}
