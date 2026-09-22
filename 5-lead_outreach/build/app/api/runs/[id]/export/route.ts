import { NextResponse } from 'next/server';
import { query } from '../../../../../lib/db.ts';
import { loadRun } from '../../../../../lib/runs.ts';

export const dynamic = 'force-dynamic';

type LeadRow = {
  id: string; company_name: string; company_domain: string; qualification_status: string;
  confidence: string; fit_reasons: string[]; concerns: string[]; source_urls: string[];
  source_summary: string | null; human_status: string | null; drafts_blocked: string | null;
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
  const { id } = await ctx.params;
  const format = new URL(request.url).searchParams.get('format') ?? 'csv';

  let run;
  try { run = await loadRun(id); } catch {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }

  const leads = await query<LeadRow>(
    `select id, company_name, company_domain, qualification_status, confidence,
            fit_reasons, concerns, source_urls, source_summary, human_status, drafts_blocked
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

  const header = ['company_name', 'company_domain', 'qualification_status', 'confidence',
    'fit_reasons', 'concerns', 'source_urls', 'source_summary', 'human_status',
    'email_1_subject', 'email_1_body', 'email_2_subject', 'email_2_body',
    'email_3_subject', 'email_3_body', 'linkedin_message', 'drafts_blocked', 'objective'];

  const rows = leads.map((l) => {
    const d = (step: number) => draftsFor(l.id).find((x) => x.step === step);
    return [
      l.company_name, l.company_domain, l.qualification_status, l.confidence,
      l.fit_reasons.join(' | '), l.concerns.join(' | '), l.source_urls.join(' | '),
      l.source_summary, l.human_status,
      d(1)?.subject, d(1)?.body, d(2)?.subject, d(2)?.body, d(3)?.subject, d(3)?.body,
      d(0)?.body, l.drafts_blocked, run.objective,
    ].map(csvCell).join(',');
  });

  return new NextResponse([header.join(','), ...rows].join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="lead-list-${id.slice(0, 8)}.csv"`,
    },
  });
}
