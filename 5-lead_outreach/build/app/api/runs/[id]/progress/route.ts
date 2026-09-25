import { NextResponse } from 'next/server';
import { loadRun, runStats } from '../../../../../lib/runs.ts';
import { query } from '../../../../../lib/db.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

/** Polled by the run page while a run is in flight. Cheap: three reads, no
 *  provider calls, nothing that costs money to look at. */
export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  try {
    const run = await loadRun(id);
    if (!canSeeRun(user, run)) {
      return NextResponse.json({ error: 'No such run.' }, { status: 404 });
    }
    return NextResponse.json({
      status: run.status,
      turns: run.agent_turns,
      needsClarification: run.needs_clarification,
      shortfallReason: run.shortfall_reason,
      candidatesRemaining: Math.max(0, run.candidate_budget - run.candidates_used),
      scrapesRemaining: Math.max(0, run.scrape_budget - run.scrapes_used),
      // No cost here either. Taking it off the strip and leaving it in the
      // payload would move the disclosure rather than remove it: any operator
      // could still read a run's spend straight from this endpoint.
      stats: await runStats(id),

      /**
       * What the agent is actually doing, which the strip above could never
       * show: turns and budgets say how much is left, not what is happening.
       * `purpose` is the agent's own statement of why it made the call, and it
       * is already written to this table on every call.
       *
       * Four columns, not the row. `input_summary` and `result_summary` are
       * redacted but they are still the scraped world, and a live feed is not
       * where that belongs. `cost_usd` is left out for the same reason the
       * strip leaves it out.
       */
      activity: await query<{
        tool_name: string; purpose: string | null; status: string; created_at: Date;
      }>(
        `select tool_name, purpose, status, created_at
           from public.tool_calls
          where run_id = $1
          order by created_at desc
          limit 8`,
        [id],
      ),
    });
  } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
}
