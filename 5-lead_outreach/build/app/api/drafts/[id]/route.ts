import { NextResponse } from 'next/server';
import { query, one } from '../../../../lib/db.ts';
import { runCopyGates, isBlocked, blockingReasons } from '../../../../lib/gates/copy.ts';
import { requireUser, canSeeRun } from '../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

/**
 * A human edit runs the same gates the agent's draft ran.
 *
 * The rule is about what leaves under Koya's name, not about who wrote it, so
 * an editor cannot paste an em dash back in any more than the model could.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({})) as
    { subject?: string; body?: string; personalization_note?: string };

  const draft = await one<{
    id: string; step: number; subject: string | null; body: string;
    lead_id: string; run_id: string; company_domain: string; source_summary: string | null;
    created_by: string | null;
  }>(
    `select d.id, d.step, d.subject, d.body, d.lead_id,
            l.run_id, l.company_domain, l.source_summary, r.created_by
       from public.outreach_drafts d
       join public.leads l on l.id = d.lead_id
       join public.runs  r on r.id = l.run_id
      where d.id = $1`,
    [id],
  );
  if (!draft) return NextResponse.json({ error: 'No such draft.' }, { status: 404 });
  if (!canSeeRun(user, draft)) {
    return NextResponse.json({ error: 'No such draft.' }, { status: 404 });
  }

  const pages = await query<{ screened_summary: string | null }>(
    `select screened_summary from public.scraped_pages
      where run_id = $1 and company_domain = $2`,
    [draft.run_id, draft.company_domain],
  );
  const sourceText = [draft.source_summary ?? '', ...pages.map((p) => p.screened_summary ?? '')]
    .join('\n');

  const next = {
    step: draft.step,
    subject: body.subject ?? draft.subject ?? undefined,
    body: body.body ?? draft.body,
  };
  const results = runCopyGates(next, sourceText);

  if (isBlocked(results)) {
    return NextResponse.json(
      { error: 'This edit does not pass the copy gates.',
        reason: blockingReasons(results).join('; '), results },
      { status: 422 });
  }

  await query(
    `update public.outreach_drafts
        set subject = $2, body = $3,
            personalization_note = coalesce($4, personalization_note),
            gate_results = $5, edited_by_human = true
      where id = $1`,
    [id, next.subject ?? null, next.body, body.personalization_note ?? null,
     JSON.stringify(results)],
  );

  return NextResponse.json({ saved: true, results });
}
