import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * One pool per process, reused across hot reloads.
 *
 * Two things about running Postgres under serverless that this encodes:
 *
 * - `max: 3`. Each concurrent function instance holds its own pool, so a low
 *   per-process ceiling is what keeps a traffic spike from exhausting the
 *   database's connection slots. The pooled Neon host (-pooler) does the real
 *   multiplexing; this number just stops one instance hogging it.
 *
 * - The pool is cached on `globalThis` in development. Without it, every hot
 *   reload leaks a pool, and after twenty edits the app fails to connect for
 *   reasons that look nothing like the edit that caused them.
 */
const globalForDb = globalThis as unknown as { __koyaPool?: Pool };

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy build/.env.example to build/.env.local and fill it in.",
    );
  }
  return url;
}

export function pool(): Pool {
  if (!globalForDb.__koyaPool) {
    const p = new Pool({
      connectionString: connectionString(),
      /**
       * Three, and measured rather than assumed.
       *
       * The workspace issues six queries at once, so this looks like a
       * throttle worth raising: two waves instead of one, against a database
       * roughly 230ms away. Benchmarked at 15 samples per configuration, it
       * is not. Median for the six queries was 524ms through a pool of
       * three and 531ms through a pool of eight, well inside the run-to-run
       * variance. Neon's pooler is already multiplexing, so widening this
       * end of the pipe buys nothing, and three is the right number for
       * serverless, where the count that matters is instances times this.
       */
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // Neon terminates idle TLS connections; without a statement timeout a
      // wedged query would hold one of our three slots until the function dies.
      statement_timeout: 20_000,
    });
    // A pool-level error with no listener is an unhandled 'error' event, which
    // takes the whole process down. Log it and let the pool replace the client.
    p.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", scope: "pg.pool", message: err.message }));
    });
    globalForDb.__koyaPool = p;
  }
  return globalForDb.__koyaPool;
}

/**
 * Round-trip instrumentation, off unless `DEBUG_SQL` is set.
 *
 * This exists because "the pages are slow" is not a diagnosis. The database
 * is a managed Postgres in another region and a single round trip costs
 * roughly 230ms from here, so page latency is almost entirely a function of
 * how many queries a request makes in sequence, not how fast any of them
 * runs. Counting them is the only way to tell a slow query from twenty
 * quick ones, and those two have opposite fixes.
 *
 * Set DEBUG_SQL=1 to print every statement with its duration.
 */
const DEBUG_SQL = process.env.DEBUG_SQL === "1";

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  if (!DEBUG_SQL) {
    const res = await pool().query<T>(sql, params as unknown[]);
    return res.rows;
  }
  const started = Date.now();
  try {
    const res = await pool().query<T>(sql, params as unknown[]);
    return res.rows;
  } finally {
    console.log(
      `[sql ${String(Date.now() - started).padStart(5)}ms] ${sql.replace(/\s+/g, " ").trim().slice(0, 110)}`,
    );
  }
}

/** Returns the first row, or null. For lookups by primary key. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, committing on return and rolling back on
 * throw. Used by every multi-table state change — a proposal transition that
 * writes `proposals`, `section_versions` and `events` must be all or nothing,
 * or the audit trail ends up describing a transition that did not happen.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Closes the pool. Only for scripts and tests — never in a request path. */
export async function closePool(): Promise<void> {
  const p = globalForDb.__koyaPool;
  if (p) {
    globalForDb.__koyaPool = undefined;
    await p.end();
  }
}
