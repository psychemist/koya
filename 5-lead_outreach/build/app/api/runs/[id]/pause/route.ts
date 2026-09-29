import { NextResponse } from 'next/server';
import { one } from '../../../../../lib/db.ts';
import { loadRun, isTerminal } from '../../../../../lib/runs.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

/**
 * Park a run, or let it go again.
 *
 * Pausing writes a flag and nothing else, because there is nothing else to
 * write: the ICP, the candidates, the pages and the verdicts are all on disk
 * already, each written by the tool that produced it. The flag is read in two
 * places, which together are the whole mechanism. The claim query skips a
 * paused run, so no worker starts one. The budget hook refuses every paid tool
 * on a paused run, which is what stops the session that was already running.
 *
 * Resuming requeues it. The status has to go back to `queued` with the lease
 * cleared, because the claim predicate only takes a queued run with no claim
 * or a stale one, and a run sitting at `researching` with a null `claimed_at`
 * matches neither. The clarification answer does exactly the same thing for
 * exactly the same reason.
 *
 * What a resumed run does NOT get back is the agent's conversation. That lives
 * in the worker process and is not persisted, so a fresh session starts and
 * reads the stored rows through get_run_state. It re-discovers nothing and
 * re-judges nothing; it pays to work out where it got to.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({})) as { paused?: unknown };
  if (typeof body.paused !== 'boolean') {
    return NextResponse.json({ error: 'Say whether to pause or resume.' }, { status: 400 });
  }

  let run;
  try { run = await loadRun(id); } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  if (!canSeeRun(user, run)) {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }

  // A finished run has nothing to stop or restart. Continuing one is a
  // different action with its own button, because it starts a new run.
  if (isTerminal(run.status)) {
    return NextResponse.json(
      { error: `This run is ${run.status.replace(/_/g, ' ')}, so there is nothing to ` +
               'pause. Continue it instead to carry its criteria into a new run.' },
      { status: 409 });
  }

  if (body.paused) {
    const paused = await one<{ id: string }>(
      `update public.runs
          set paused_at = now(), paused_by = $2, version = version + 1
        where id = $1 and paused_at is null
        returning id`,
      [id, user.id]);
    if (!paused) {
      return NextResponse.json({ error: 'This run is already paused.' }, { status: 409 });
    }
    return NextResponse.json({ paused: true });
  }

  /**
   * Resume clears the lease as well as the flag.
   *
   * The worker that was holding this run stopped heartbeating the moment it
   * finished its turn, so its claim is stale. Leaving `claimed_by` set would
   * make the run look busy on a page that is trying to explain why nothing is
   * happening.
   */
  const resumed = await one<{ id: string }>(
    `update public.runs
        set paused_at = null, paused_by = null,
            status = 'queued', claimed_by = null, claimed_at = null,
            version = version + 1
      where id = $1 and paused_at is not null
      returning id`,
    [id]);
  if (!resumed) {
    return NextResponse.json({ error: 'This run is not paused.' }, { status: 409 });
  }
  return NextResponse.json({ paused: false });
}
