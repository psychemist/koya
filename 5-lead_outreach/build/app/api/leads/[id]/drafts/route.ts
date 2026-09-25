import { NextResponse } from 'next/server';
import { one } from '../../../../../lib/db.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';
import { draftForLead } from '../../../../../lib/drafting.ts';
import { ProviderError } from '../../../../../lib/errors.ts';

export const dynamic = 'force-dynamic';

/**
 * Write the outreach for one qualified lead, on request.
 *
 * Every failure here is something the reviewer can act on, so each maps to a
 * status and a sentence rather than to a 500. A rejected redraft is a 422
 * naming the gate, not an error.
 */
const STATUS: Record<string, number> = {
  DRAFT_NO_LEAD: 404,
  DRAFT_NOT_QUALIFIED: 409,
  DRAFT_NO_EVIDENCE: 409,
  DRAFT_GATES_FAILED: 422,
  BUDGET_DAY: 429,
};

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const lead = await one<{ id: string; created_by: string | null }>(
    `select l.id, r.created_by from public.leads l
       join public.runs r on r.id = l.run_id
      where l.id = $1`, [id]);
  if (!lead || !canSeeRun(user, lead)) {
    return NextResponse.json({ error: 'No such lead.' }, { status: 404 });
  }

  try {
    const out = await draftForLead(id);
    return NextResponse.json({ saved: out.saved, costUsd: out.costUsd });
  } catch (e) {
    if (e instanceof ProviderError && STATUS[e.code]) {
      return NextResponse.json({ error: e.message }, { status: STATUS[e.code] });
    }
    throw e;
  }
}
