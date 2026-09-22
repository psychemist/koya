import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startup } from '@anthropic-ai/claude-agent-sdk';
import { query, one, pool } from '../lib/db.ts';
import { loadRun, transition, type RunRow } from '../lib/runs.ts';
import { runAgent, agentOptions } from '../lib/agent/run-agent.ts';
import { assertApifyAccount } from '../lib/providers/apify.ts';
import { config } from '../lib/config.ts';

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_MS = 3_000;
const HEARTBEAT_MS = 60_000;

/**
 * Claim exactly one run.
 *
 * `for update skip locked` is what makes two workers racing safe: the second
 * one skips the row the first is holding rather than blocking on it. The lease
 * window is what makes a killed worker recoverable: a run whose claim went
 * stale becomes claimable again instead of being stranded forever.
 */
export async function claimOne(workerId: string): Promise<RunRow | null> {
  return one<RunRow>(
    `update public.runs
        set claimed_by = $1, claimed_at = now(), version = version + 1
      where id = (
        select id from public.runs
         where status = 'queued'
            or (status not in ('complete','partial','failed')
                and claimed_at < now() - interval '15 minutes')
         order by created_at
         for update skip locked
         limit 1
      )
      returning *`,
    [workerId],
  );
}

/** Keeps the lease fresh while a long run is genuinely working, so a healthy
 *  worker is never mistaken for a dead one. */
function heartbeat(runId: string) {
  const timer = setInterval(() => {
    query('update public.runs set claimed_at = now() where id = $1', [runId])
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

const log = (level: string, message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, at: 'worker', worker: WORKER_ID, message, ...extra }));

async function handle(run: RunRow): Promise<void> {
  const stop = heartbeat(run.id);
  try {
    if (run.status === 'queued') {
      await transition(run.id, 'queued', 'refining_icp');
    }
    const outcome = await runAgent(run.id);
    const after = await loadRun(run.id);
    log('info', 'run finished', {
      run: run.id, subtype: outcome.subtype, status: after.status,
      turns: outcome.turns, costUsd: outcome.costUsd,
    });
  } catch (e) {
    // An uncaught throw must not leave the run stuck in a transient status
    // that no state machine will ever move again.
    log('error', 'run failed', { run: run.id, error: e instanceof Error ? e.message : String(e) });
    await transition(run.id,
      ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'], 'failed',
      undefined,
      { error_message: e instanceof Error ? e.message : String(e), finished_at: new Date() },
    ).catch(() => undefined);
  } finally {
    stop();
  }
}

async function boot() {
  // A worker that cannot log is a worker that should not run an agent.
  await query('select 1');
  log('info', 'database reachable');

  try {
    const account = await assertApifyAccount();
    log('info', 'apify account asserted', { account });
  } catch (e) {
    // Caught here rather than in the billing summary.
    log('error', 'apify identity check failed',
      { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  // Pay the CLI handshake once at boot rather than once per run.
  await startup({ options: { model: config.models.agent } }).catch((e) =>
    log('warn', 'prewarm failed, first run will pay the handshake',
      { error: e instanceof Error ? e.message : String(e) }));

  log('info', 'worker ready');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true; log('info', `${signal} received, draining`); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await boot();
  while (!stopping) {
    const run = await claimOne(WORKER_ID).catch((e) => {
      log('error', 'claim failed', { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    if (run) {
      log('info', 'claimed run', { run: run.id, objective: run.objective.slice(0, 80) });
      await handle(run);
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  await pool().end();
  log('info', 'worker stopped');
}

export { agentOptions };
