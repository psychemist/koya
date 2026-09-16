import { Pool, type PoolClient } from 'pg';
import { config } from './config';

/**
 * One pool, reused across hot reloads in dev.
 *
 * Connects to Supabase Postgres as a privileged role, so it BYPASSES row
 * level security. That is intended: this app is the authorisation layer —
 * ownership, separation of duties and state are enforced in the route
 * handlers. RLS (db/migrations/0001_init.sql) is defence in depth against
 * the PostgREST Data API that Supabase exposes whether or not we use it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __koyaPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__koyaPool) {
    globalThis.__koyaPool = new Pool({
      connectionString: config.databaseUrl(),
      ssl: { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    globalThis.__koyaPool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', at: 'pg_pool', message: err.message }));
    });
  }
  return globalThis.__koyaPool;
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

/**
 * Optimistic concurrency. Every state change goes through here.
 *
 * Returns null when the row moved under us — a stale version or a status
 * that is no longer what the caller believed. The caller turns that into a
 * 409 that says nothing was lost, rather than silently overwriting someone.
 */
export async function advance(
  id: string,
  fromStatus: string | string[],
  toStatus: string,
  patch: Record<string, unknown> = {},
  expectedVersion?: number,
): Promise<{ id: string; status: string; version: number } | null> {
  const statuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 5}`);
  const sql = `
    update public.content_requests
       set status = $2, version = version + 1, updated_at = now()
           ${sets.length ? ', ' + sets.join(', ') : ''}
     where id = $1
       and status = any($3)
       and ($4::int is null or version = $4)
    returning id, status, version`;
  return one(sql, [id, toStatus, statuses, expectedVersion ?? null, ...keys.map((k) => patch[k])]);
}
