import { NextResponse } from 'next/server';
import { loadRun, runStats } from '../../../../../lib/runs.ts';
import { apifySpend } from '../../../../../lib/budget.ts';
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
      apifySpendUsd: await apifySpend(id),
      // The SDK's own caveat, repeated wherever the number is shown.
      claudeCostUsd: Number(run.claude_cost_usd),
      costIsEstimate: true,
      stats: await runStats(id),
    });
  } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
}
