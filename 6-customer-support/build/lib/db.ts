import { Pool, type PoolClient } from 'pg';
import { config } from './config.ts';

/**
 * One pool per process, reused across hot reloads in dev.
 *
 * Connects to Supabase Postgres as a privileged role, so it BYPASSES row
 * level security. That is intended: these services are the authorisation
 * layer. RLS and the grant lockdown (db/lockdown.sql) are defence in depth
 * against the PostgREST Data API that Supabase exposes whether or not we use it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __relaypayPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__relaypayPool) {
    globalThis.__relaypayPool = new Pool({
      connectionString: config.db.url,
      ssl: /localhost|127\.0\.0\.1/.test(config.db.url) ? undefined : { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    globalThis.__relaypayPool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', at: 'pg_pool', message: err.message }));
    });
  }
  return globalThis.__relaypayPool;
}

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool().query(text, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** A transaction that always releases, and always rolls back on throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters more */ }
    throw e;
  } finally {
    client.release();
  }
}

/** For health checks: true when a round trip succeeds within the timeout. */
export async function dbHealthy(timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([query('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return true;
  } catch { return false; }
}
