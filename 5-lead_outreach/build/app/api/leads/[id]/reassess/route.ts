import { NextResponse } from 'next/server';
import { one } from '../../../../../lib/db.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';
import { reassessLead } from '../../../../../lib/reassess.ts';
import { ProviderError } from '../../../../../lib/errors.ts';

export const dynamic = 'force-dynamic';

/**
 * Judge one lead again, optionally after reading another page.
 *
 * Every failure is something the reviewer can act on, so each maps to a status
 * and a sentence rather than to a 500, exactly as the drafts route does.
 */
const STATUS: Record<string, number> = {
  REASSESS_NO_LEAD: 404,
  REASSESS_NO_EVIDENCE: 409,
  REASSESS_NOTHING_NEW: 409,
  REASSESS_UNREADABLE: 502,
  BUDGET_RUN: 429,
  BUDGET_DAY: 429,
};

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const body = await request.json().catch(() => ({})) as
    { research?: unknown; context?: unknown };

  try {
    const out = await reassessLead(id, {
      research: body.research === true,
      context: typeof body.context === 'string' ? body.context : undefined,
    });
    return NextResponse.json({
      status: out.verdict.qualification_status,
      confidence: out.verdict.confidence,
      readUrl: out.readUrl,
      costUsd: out.costUsd,
    });
  } catch (e) {
    if (e instanceof ProviderError && STATUS[e.code]) {
      return NextResponse.json({ error: e.message }, { status: STATUS[e.code] });
    }
    throw e;
  }
}
