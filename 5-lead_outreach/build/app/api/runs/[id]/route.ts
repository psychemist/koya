import { NextResponse } from 'next/server';
import { query, one } from '../../../../lib/db.ts';
import { loadRun, runStats } from '../../../../lib/runs.ts';
import { notificationStatus } from '../../../../lib/notify/index.ts';
import { requireUser, canSeeRun, canDeleteRun } from '../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  try {
    const run = await loadRun(id);
    // Not found rather than forbidden. Telling someone a run exists but is not
    // theirs is itself a disclosure.
    if (!canSeeRun(user, run)) {
      return NextResponse.json({ error: 'No such run.' }, { status: 404 });
    }
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
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  let run;
  try { run = await loadRun(id); } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  if (!canSeeRun(user, run)) {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  if (!canDeleteRun(user, run)) {
    return NextResponse.json(
      { error: 'Only the person who started this run, or an admin, can delete it.' },
      { status: 403 });
  }

  const row = await one<{ id: string }>(
    'delete from public.runs where id = $1 returning id', [id]);
  if (!row) return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  await query('delete from public.notifications where run_id = $1', [id]).catch(() => undefined);
  return NextResponse.json({ deleted: id });
}
