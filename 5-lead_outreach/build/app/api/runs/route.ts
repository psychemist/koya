import { NextResponse } from 'next/server';
import { one } from '../../../lib/db.ts';
import { sha256 } from '../../../lib/hash.ts';
import { config } from '../../../lib/config.ts';

export const dynamic = 'force-dynamic';

const OPERATOR = 'operator';

/** Same objective, same person, same day is the same run. A double submit
 *  from an impatient click must not queue two paid runs. */
function idempotencyKey(objective: string): string {
  const normalised = objective.trim().toLowerCase().replace(/\s+/g, ' ');
  return sha256(`${normalised}|${OPERATOR}|${new Date().toISOString().slice(0, 10)}`);
}

export async function POST(request: Request) {
  let body: { objective?: string; geography?: string; headcount?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body with an objective.' }, { status: 400 });
  }

  const objective = (body.objective ?? '').trim();
  if (objective.length < 10) {
    return NextResponse.json(
      { error: 'Describe what you are looking for in a sentence or more.' }, { status: 422 });
  }

  const parts = [objective];
  if (body.geography?.trim()) parts.push(`Geography: ${body.geography.trim()}`);
  if (body.headcount?.trim()) parts.push(`Headcount: ${body.headcount.trim()}`);
  const full = parts.join('. ');

  const run = await one<{ id: string; status: string }>(
    `insert into public.runs
       (idempotency_key, objective, status, candidate_budget, scrape_budget, apify_cap_usd)
     values ($1,$2,'queued',$3,$4,$5)
     on conflict (idempotency_key) do update set objective = public.runs.objective
     returning id, status`,
    [idempotencyKey(objective), full, config.limits.candidateBudget,
     config.limits.scrapeBudget, config.limits.runApifyCapUsd],
  );

  return NextResponse.json({ id: run!.id, status: run!.status }, { status: 201 });
}
