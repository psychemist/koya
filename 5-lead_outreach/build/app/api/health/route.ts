import { NextResponse } from 'next/server';
import { query } from '../../../lib/db.ts';
import { config } from '../../../lib/config.ts';

export const dynamic = 'force-dynamic';

/**
 * Database and configuration only. Provider reachability probes cost money,
 * so they are not part of a route anything can poll.
 *
 * Every value here is a boolean or a count. A health route that returns a
 * configured value is a health route that leaks one.
 */
export async function GET() {
  let database: 'up' | 'down' = 'down';
  let migrations = 0;

  try {
    const rows = await query<{ count: string }>(
      'select count(*)::text as count from public.schema_migrations',
    );
    migrations = Number(rows[0]?.count ?? 0);
    database = 'up';
  } catch {
    database = 'down';
  }

  const configured = config.configured();
  return NextResponse.json(
    { ok: database === 'up', database, migrations, configured },
    { status: database === 'up' ? 200 : 503 },
  );
}
