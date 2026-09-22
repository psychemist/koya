import { NextResponse } from 'next/server';
import { query, one } from '../../../../lib/db.ts';
import { loadRun, runStats } from '../../../../lib/runs.ts';
import { notificationStatus } from '../../../../lib/notify/index.ts';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const run = await loadRun(id);
    return NextResponse.json({
      run,
      stats: await runStats(id),
      notifications: await notificationStatus(id),
    });
  } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
}

/**
 * The only destructive action in the product.
 *
 * Deleting a run deletes its leads, its drafts, its scraped evidence and its
 * tool-call log, because the evidence only means anything attached to the run
 * it justifies. The dialog says so before this is ever called.
 */
export async function DELETE(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = await one<{ id: string }>(
    'delete from public.runs where id = $1 returning id', [id]);
  if (!row) return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  await query('delete from public.notifications where run_id = $1', [id]).catch(() => undefined);
  return NextResponse.json({ deleted: id });
}
