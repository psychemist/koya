import { NextResponse } from 'next/server';
import { one } from '../../../../../lib/db.ts';
import { loadRun } from '../../../../../lib/runs.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

/**
 * The answer half of the one blocking gate in this system.
 *
 * A parked run is frozen: the hook refuses every tool that costs money while
 * `needs_clarification` is set, and the worker will not reclaim it. That is
 * correct, and it makes this route the only way the run ever moves again.
 *
 * The answer is appended to the objective rather than stored beside it,
 * because the objective is what the agent is given. An answer the agent cannot
 * read would park the run a second time on the same question.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({})) as { answer?: string };
  const answer = (body.answer ?? '').trim();

  if (answer.length < 2) {
    return NextResponse.json(
      { error: 'Write an answer the agent can act on.' }, { status: 422 });
  }

  let run;
  try { run = await loadRun(id); } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  if (!canSeeRun(user, run)) {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  if (!run.needs_clarification) {
    return NextResponse.json(
      { error: 'This run is not waiting on an answer.' }, { status: 409 });
  }

  // Back to `queued` with the lease cleared, which is what makes it claimable
  // again: the worker skips anything with `needs_clarification` set, and the
  // claim predicate wants a queued run with no live claim.
  const updated = await one<{ id: string }>(
    `update public.runs
        set objective           = objective || E'\\n\\n' || $2,
            needs_clarification = null,
            status              = 'queued',
            claimed_by          = null,
            claimed_at          = null,
            version             = version + 1
      where id = $1 and needs_clarification is not null
      returning id`,
    [id, `The operator was asked: ${run.needs_clarification}\nThey answered: ${answer}`],
  );
  if (!updated) {
    return NextResponse.json({ error: 'That question was already answered.' }, { status: 409 });
  }

  return NextResponse.json({ requeued: true });
}
