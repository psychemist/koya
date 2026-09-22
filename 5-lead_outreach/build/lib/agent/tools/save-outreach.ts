import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed, refused } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query, one } from '../../db.ts';
import { runCopyGates, isBlocked, blockingReasons } from '../../gates/copy.ts';
import { advanceTo } from '../../runs.ts';

/** Two rewrites, then a human writes it. Counted in the process because a
 *  worker that restarts mid-run should give the agent a fresh chance rather
 *  than inherit a block it cannot see the reason for. */
const attempts = new Map<string, number>();

export const saveOutreach = tool(
  'save_outreach',
  'Store the 3-step email sequence and the LinkedIn message for one qualified lead. ' +
  'Every draft is checked against the house style, grounding and safety gates before ' +
  'it is written. A draft that fails a blocking gate is rejected with the gate named.',
  {
    ...baseArgs,
    lead_id: z.string().uuid(),
    steps: z.array(z.object({
      step: z.number().int().min(0).max(3)
        .describe('1, 2 and 3 are the emails in order. 0 is the LinkedIn message.'),
      subject: z.string().optional().describe('Emails only. 60 characters or fewer.'),
      body: z.string(),
      personalization_note: z.string()
        .describe('Which specific detail this draft uses, and where it came from.'),
      source_url: z.string().optional(),
    })).min(1),
  },
  async (args) => {
    try {
      return await withToolCall(args.run_id, 'save_outreach', args.purpose, args, async () => {
        const lead = await one<{
          id: string; company_domain: string; source_summary: string | null;
          qualification_status: string;
        }>(
          'select id, company_domain, source_summary, qualification_status ' +
          'from public.leads where id = $1 and run_id = $2',
          [args.lead_id, args.run_id],
        );
        if (!lead) {
          return {
            value: refused('No such lead on this run.'),
            resultSummary: { rejected: 'unknown lead' },
          };
        }
        if (lead.qualification_status !== 'qualified') {
          return {
            value: refused(
              `${lead.company_domain} is ${lead.qualification_status}, not qualified. ` +
              'Drafts are written for qualified leads only.'),
            resultSummary: { rejected: 'not qualified' },
          };
        }

        // Grounding is checked against the stored evidence for THIS lead, plus
        // the page excerpts, so a draft cannot be grounded in another company.
        const pages = await query<{ screened_summary: string | null }>(
          'select screened_summary from public.scraped_pages where run_id = $1 and company_domain = $2',
          [args.run_id, lead.company_domain],
        );
        const sourceText = [lead.source_summary ?? '', ...pages.map((p) => p.screened_summary ?? '')]
          .join('\n');

        const perStep = args.steps.map((s) => ({
          step: s,
          results: runCopyGates({ step: s.step, subject: s.subject, body: s.body }, sourceText),
        }));
        const failing = perStep.filter((p) => isBlocked(p.results));

        if (failing.length) {
          const n = (attempts.get(args.lead_id) ?? 0) + 1;
          attempts.set(args.lead_id, n);
          const detail = failing
            .map((f) => `step ${f.step.step}: ${blockingReasons(f.results).join('; ')}`)
            .join('\n');

          if (n >= 3) {
            await query('update public.leads set drafts_blocked = $2 where id = $1',
              [args.lead_id, detail]);
            attempts.delete(args.lead_id);
            return {
              value: refused(
                `Drafts for ${lead.company_domain} failed the gates three times and are now ` +
                `marked for a human to write by hand. Move on to the next lead.\n${detail}`),
              resultSummary: { blocked: true, detail },
            };
          }

          return {
            value: refused(
              `save_outreach rejected. Rewrite and call again.\n${detail}`),
            resultSummary: { rejected: detail, attempt: n },
          };
        }

        await advanceTo(args.run_id, 'drafting');

        for (const { step, results } of perStep) {
          await query(
            `insert into public.outreach_drafts
               (lead_id, step, subject, body, personalization_note, source_url, gate_results)
             values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (lead_id, step) do update
               set subject = excluded.subject, body = excluded.body,
                   personalization_note = excluded.personalization_note,
                   source_url = excluded.source_url, gate_results = excluded.gate_results`,
            [args.lead_id, step.step, step.subject ?? null, step.body,
             step.personalization_note, step.source_url ?? null, JSON.stringify(results)],
          );
        }
        await query('update public.leads set drafts_blocked = null where id = $1',
          [args.lead_id]);
        attempts.delete(args.lead_id);

        const advisories = perStep.flatMap(({ step, results }) =>
          results.filter((r) => r.severity === 'advisory' && !r.passed)
            .map((r) => `step ${step.step}: ${r.detail}`));

        return {
          value: ok({ saved: args.steps.length, domain: lead.company_domain, advisories }),
          resultSummary: { domain: lead.company_domain, steps: args.steps.length,
                           advisories: advisories.length },
        };
      });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: false } },
);
