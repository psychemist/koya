import { NextResponse } from 'next/server';
import { query } from '../../../../../lib/db.ts';
import { loadRun } from '../../../../../lib/runs.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

type LeadRow = {
  id: string; company_name: string; company_domain: string; qualification_status: string;
  confidence: string; fit_reasons: string[]; concerns: string[]; source_urls: string[];
  source_summary: string | null; human_status: string | null; human_note: string | null;
  drafts_blocked: string | null;
};

type DraftRow = {
  lead_id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null; edited_by_human: boolean;
};

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Every export carries the ICP, the reasoning and the sources.
 *
 * A lead list handed to a salesperson without its evidence is the thing this
 * system exists to replace, so the evidence is not an optional column.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const format = new URL(request.url).searchParams.get('format') ?? 'csv';

  let run;
  try { run = await loadRun(id); } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }
  // An export carries every lead, every reason and every source. It is the
  // most disclosive thing in the product, so it gets the same check as the page.
  if (!canSeeRun(user, run)) {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }

  const leads = await query<LeadRow>(
    `select id, company_name, company_domain, qualification_status, confidence,
            fit_reasons, concerns, source_urls, source_summary,
            human_status, human_note, drafts_blocked
       from public.leads where run_id = $1 order by qualification_status, company_name`,
    [id],
  );
  const drafts = await query<DraftRow>(
    `select d.lead_id, d.step, d.subject, d.body, d.personalization_note, d.source_url,
            d.edited_by_human
       from public.outreach_drafts d join public.leads l on l.id = d.lead_id
      where l.run_id = $1 order by d.step`,
    [id],
  );
  const draftsFor = (leadId: string) => drafts.filter((d) => d.lead_id === leadId);

  if (format === 'md') {
    const icp = run.icp as Record<string, unknown> | null;
    const md = [
      '# Koya Lead Desk export',
      '',
      `**Objective:** ${run.objective}`,
      `**Run status:** ${run.status}`,
      run.shortfall_reason ? `**Shortfall:** ${run.shortfall_reason}` : '',
      '',
      '## Refined ICP',
      '',
      icp ? '```json\n' + JSON.stringify(icp, null, 2) + '\n```' : 'No ICP was stored.',
      '',
      '## Leads',
      '',
      ...leads.flatMap((l) => [
        `### ${l.company_name} (${l.company_domain})`,
        '',
        `Verdict: **${l.qualification_status}**, confidence ${l.confidence}` +
          (l.human_status ? `. Reviewer marked it ${l.human_status}.` : ''),
        '',
        '**Why it fits**',
        ...l.fit_reasons.map((r) => `- ${r}`),
        '',
        '**Concerns**',
        ...(l.concerns.length ? l.concerns.map((c) => `- ${c}`) : ['- None recorded.']),
        '',
        '**Sources**',
        ...l.source_urls.map((u) => `- ${u}`),
        '',
        l.source_summary ? `**Source summary:** ${l.source_summary}` : '',
        '',
        ...(l.drafts_blocked
          ? [`**Drafts blocked:** ${l.drafts_blocked}`, '']
          : draftsFor(l.id).flatMap((d) => [
              d.step === 0 ? '**LinkedIn message**' : `**Email ${d.step}**` +
                (d.subject ? ` - ${d.subject}` : ''),
              '',
              d.body,
              '',
              d.personalization_note ? `*Personalization: ${d.personalization_note}` +
                (d.source_url ? ` (${d.source_url})` : '') + '*' : '',
              d.edited_by_human ? '*Edited by a reviewer.*' : '',
              '',
            ])),
      ]),
    ].filter((line) => line !== undefined).join('\n');

    return new NextResponse(md, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="lead-list-${id.slice(0, 8)}.md"`,
      },
    });
  }

  // The ICP travels with every row. A lead list without the criteria it was
  // judged against is the thing this system exists to replace, and the CSV is
  // the copy that actually gets forwarded.
  const icp = run.icp as Record<string, unknown> | null;
  const hardFilters = Array.isArray(icp?.hard_filters)
    ? (icp!.hard_filters as string[]).join(' | ') : '';
  const softPreferences = Array.isArray(icp?.soft_preferences)
    ? (icp!.soft_preferences as string[]).join(' | ') : '';

  const header = ['company_name', 'company_domain', 'qualification_status', 'confidence',
    'fit_reasons', 'concerns', 'source_urls', 'source_summary',
    'human_status', 'human_note',
    'email_1_subject', 'email_1_body', 'email_1_personalization',
    'email_2_subject', 'email_2_body', 'email_2_personalization',
    'email_3_subject', 'email_3_body', 'email_3_personalization',
    'linkedin_message', 'linkedin_personalization',
    'drafts_blocked', 'objective', 'icp_hard_filters', 'icp_soft_preferences'];

  const rows = leads.map((l) => {
    const d = (step: number) => draftsFor(l.id).find((x) => x.step === step);
    const note = (step: number) => {
      const draft = d(step);
      if (!draft?.personalization_note) return '';
      return draft.source_url
        ? `${draft.personalization_note} (${draft.source_url})`
        : draft.personalization_note;
    };
    return [
      l.company_name, l.company_domain, l.qualification_status, l.confidence,
      l.fit_reasons.join(' | '), l.concerns.join(' | '), l.source_urls.join(' | '),
      l.source_summary, l.human_status, l.human_note,
      d(1)?.subject, d(1)?.body, note(1),
      d(2)?.subject, d(2)?.body, note(2),
      d(3)?.subject, d(3)?.body, note(3),
      d(0)?.body, note(0),
      l.drafts_blocked, run.objective, hardFilters, softPreferences,
    ].map(csvCell).join(',');
  });

  return new NextResponse([header.join(','), ...rows].join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="lead-list-${id.slice(0, 8)}.csv"`,
    },
  });
}
