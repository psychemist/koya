import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../lib/db.ts';
import { loadRun, runStats } from '../lib/runs.ts';

/**
 * Writes the submission artefacts from a real run.
 *
 * Usage: npm run sample -- <run-id>
 *
 * The sample pack is the evidence that the drafts are grounded, so it carries
 * the source context next to the copy rather than the copy on its own.
 */
const runId = process.argv[2];
if (!runId) {
  console.error('Usage: npm run sample -- <run-id>');
  process.exit(1);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = await loadRun(runId);
const stats = await runStats(runId);

type Lead = {
  id: string; company_name: string; company_domain: string; qualification_status: string;
  confidence: string; fit_reasons: string[]; concerns: string[]; source_urls: string[];
  source_summary: string | null; drafts_blocked: string | null;
};

const leads = await query<Lead>(
  `select id, company_name, company_domain, qualification_status, confidence, fit_reasons,
          concerns, source_urls, source_summary, drafts_blocked
     from public.leads where run_id = $1
    order by case qualification_status when 'qualified' then 0
             when 'needs_review' then 1 else 2 end, company_name`, [runId]);

const drafts = await query<{
  lead_id: string; step: number; subject: string | null; body: string;
  personalization_note: string | null; source_url: string | null;
}>(
  `select d.lead_id, d.step, d.subject, d.body, d.personalization_note, d.source_url
     from public.outreach_drafts d join public.leads l on l.id = d.lead_id
    where l.run_id = $1 order by d.step`, [runId]);

const qualified = leads.filter((l) => l.qualification_status === 'qualified');
const stepName = (s: number) => (s === 0 ? 'LinkedIn message' : `Email ${s}`);

const pack = [
  '# Outreach sample pack',
  '',
  `**Objective:** ${run.objective}`,
  `**Run status:** ${run.status}`,
  run.shortfall_reason ? `**Shortfall:** ${run.shortfall_reason}` : '',
  `**Result:** ${stats.qualified} qualified of ${stats.assessed} assessed. ` +
    `${stats.needsReview} marked for review.`,
  `**Cost:** Apify $${Number(run.apify_spend_usd).toFixed(2)}, ` +
    `Claude $${Number(run.claude_cost_usd).toFixed(2)} ` +
    '(client-side estimate, not billing data).',
  '',
  '## The criteria these companies were judged against',
  '',
  run.icp ? '```json\n' + JSON.stringify(run.icp, null, 2) + '\n```' : 'No ICP was stored.',
  '',
  ...qualified.flatMap((l) => [
    `## ${l.company_name}`,
    '',
    `Domain: ${l.company_domain}. Confidence ${l.confidence}.`,
    '',
    '### Source context',
    '',
    l.source_summary ?? 'No summary stored.',
    '',
    ...l.source_urls.map((u) => `- ${u}`),
    '',
    '### Why it qualified',
    '',
    ...l.fit_reasons.map((r) => `- ${r}`),
    '',
    l.concerns.length ? '### Concerns\n' : '',
    ...l.concerns.map((c) => `- ${c}`),
    '',
    '### The sequence',
    '',
    ...(l.drafts_blocked
      ? [`Drafts were blocked and need writing by hand: ${l.drafts_blocked}`, '']
      : drafts.filter((d) => d.lead_id === l.id).flatMap((d) => [
          `**${stepName(d.step)}**${d.subject ? `, subject: ${d.subject}` : ''}`,
          '',
          d.body,
          '',
          d.personalization_note
            ? `*Grounded in: ${d.personalization_note}` +
              (d.source_url ? ` (${d.source_url})` : '') + '*'
            : '',
          '',
        ])),
  ]),
].filter((l) => l !== '').join('\n');

const header = ['company_name', 'company_domain', 'qualification_status', 'confidence',
                'fit_reasons', 'concerns', 'source_urls', 'source_summary'];
const csv = [
  header.join(','),
  ...leads.map((l) => [
    l.company_name, l.company_domain, l.qualification_status, l.confidence,
    l.fit_reasons.join(' | '), l.concerns.join(' | '), l.source_urls.join(' | '),
    l.source_summary,
  ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')),
].join('\n');

await writeFile(join(outDir, 'outreach-sample-pack.md'), pack, 'utf8');
await writeFile(join(outDir, 'lead-list.csv'), csv, 'utf8');

console.log(`Wrote outreach-sample-pack.md (${qualified.length} qualified leads)`);
console.log(`Wrote lead-list.csv (${leads.length} rows)`);
