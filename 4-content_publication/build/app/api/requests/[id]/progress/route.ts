import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { progressFor } from '@/lib/pipeline/progress';

export const dynamic = 'force-dynamic';

/**
 * Polled by the live view while a run is in flight.
 *
 * Polling rather than server-sent events, and that is a decision rather than a
 * shortcut. A run is minutes long with fewer than a dozen state changes in it,
 * so an open connection per viewer buys nothing a 2.5-second poll does not
 * already give. It also survives what SSE does not: this deploys to a platform
 * that recycles instances, and a dropped stream leaves a screen that has
 * quietly stopped updating while still looking live. That failure mode is the
 * one thing this view must not have.
 *
 * The client stops polling as soon as `running` is false, so a page left open
 * on a finished request costs one request and then nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await currentUser().catch(() => null);
  // 404 rather than 401: a signed-out caller should not learn whether this id
  // exists, and the page behind this will have redirected them anyway.
  if (!user) {
    return NextResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
  }

  const progress = await progressFor(id).catch(() => null);
  if (!progress) {
    return NextResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
  }

  return NextResponse.json({ data: progress }, {
    // A cached progress response is a progress view that has stopped moving
    // while still looking live.
    headers: { 'cache-control': 'no-store' },
  });
}
