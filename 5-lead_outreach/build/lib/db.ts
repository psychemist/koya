import { Pool, type PoolClient } from 'pg';
import { config } from './config.ts';

/**
 * One pool, reused across hot reloads in dev.
 *
 * Connects to Supabase Postgres as a privileged role, so it BYPASSES row
 * level security. That is intended: this app is the authorisation layer. RLS
 * (db/migrations/0001_init.sql) is defence in depth against the PostgREST
 * Data API that Supabase exposes whether or not we use it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __koyaLeadPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__koyaLeadPool) {
    globalThis.__koyaLeadPool = new Pool({
      connectionString: config.databaseUrl(),
      ssl: { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    globalThis.__koyaLeadPool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', at: 'pg_pool', message: err.message }));
    });
  }
  return globalThis.__koyaLeadPool;
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
