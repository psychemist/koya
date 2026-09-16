import { NextResponse } from 'next/server';
import { capabilities } from '@/lib/config';
import { connectorAvailability } from '@/lib/publish';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * FREE BY DEFAULT. A health check that costs money on every probe is a health
 * check someone turns off. `?deep=1` opts into touching the database;
 * provider probes are never automatic.
 */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get('deep') === '1';
  const body: Record<string, unknown> = {
    ok: true,
    service: 'koya-content-desk',
    // Capability flags, never values. Knowing that email is configured is
    // useful; knowing the key is not something this endpoint will ever say.
    capabilities: { ...capabilities(), publish: connectorAvailability() },
  };

  if (deep) {
    try {
      const t = Date.now();
      await query('select 1');
      body.database = { ok: true, latencyMs: Date.now() - t };
    } catch (e) {
      body.ok = false;
      body.database = { ok: false, error: e instanceof Error ? e.message : 'unreachable' };
      return NextResponse.json(body, { status: 503 });
    }
  }
  return NextResponse.json(body);
}
