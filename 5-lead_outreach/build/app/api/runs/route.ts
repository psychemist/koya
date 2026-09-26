import { NextResponse } from 'next/server';
import { one } from '../../../lib/db.ts';
import { sha256 } from '../../../lib/hash.ts';
import { config } from '../../../lib/config.ts';
import { requireUser } from '../../../lib/auth.ts';
import { clampTargetLeads } from '../../../lib/budget.ts';
import { requeueIfNothingProduced } from '../../../lib/runs.ts';
import { screenObjective } from '../../../lib/intake-screen.ts';
import { composeObjective } from '../../../lib/objective.ts';

export const dynamic = 'force-dynamic';

/** Same objective, same person, same day is the same run. A double submit
 *  from an impatient click must not queue two paid runs. */
function idempotencyKey(objective: string, operatorId: string): string {
  const normalised = objective.trim().toLowerCase().replace(/\s+/g, ' ');
  return sha256(`${normalised}|${operatorId}|${new Date().toISOString().slice(0, 10)}`);
}

export async function POST(request: Request) {
  // Starting a run spends against a shared cohort account, so it is not
  // something an anonymous visitor to a public link gets to do.
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  let body: {
    objective?: string; geography?: string; headcount?: string; target_leads?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body with an objective.' }, { status: 400 });
  }

  const objective = (body.objective ?? '').trim();

  /**
   * The gate, before a row exists and before the worker can claim one.
   *
   * A brief that cannot be worked used to be discovered by a full agent loop,
   * which is 86% of what this system spends. This costs about $0.0005 and
   * fails open, so an unreachable screening model is a run that starts, not an
   * intake that is down.
   */
  const screened = await screenObjective(objective);
  if (!screened.workable) {
    return NextResponse.json({ error: screened.reason }, { status: 422 });
  }

  // Composed where it is also taken apart again, so the run page can show the
  // qualifiers on their own lines without inferring a format from this file.
  const full = composeObjective(objective, body.geography, body.headcount);

  // Clamped rather than refused, but never silently: a person who asked for a
  // hundred leads and got ten should learn that from the answer, not from the
  // shortfall reason two hours later.
  const requested = body.target_leads;
  const target = clampTargetLeads(requested);
  const wasReduced = requested !== undefined && requested !== null && requested !== ''
    && Number.isFinite(Number(requested)) && Math.floor(Number(requested)) !== target;

  const run = await one<{ id: string; status: string }>(
    `insert into public.runs
       (idempotency_key, objective, status, candidate_budget, scrape_budget, apify_cap_usd,
        target_leads, created_by)
     values ($1,$2,'queued',$3,$4,$5,$6,$7)
     on conflict (idempotency_key) do update set objective = public.runs.objective
     returning id, status`,
    [idempotencyKey(objective, user.id), full, config.limits.candidateBudget,
     config.limits.scrapeBudget, config.limits.runApifyCapUsd,
     target, user.id],
  );

  // A run refused before it started produced nothing, so its objective should
  // not be locked out for the rest of the day by its own idempotency key.
  let status = run!.status;
  if (status === 'failed' && await requeueIfNothingProduced(run!.id)) status = 'queued';

  return NextResponse.json({
    id: run!.id,
    status,
    target_leads: target,
    ...(wasReduced
      ? { notice: `You asked for ${requested} leads. A run works to at most ${target}, and `
          + 'in practice reaches about ten before a budget ends. If it finishes short it '
          + 'names which budget ran out, and you can continue it from the run page.' }
      : {}),
  }, { status: 201 });
}
