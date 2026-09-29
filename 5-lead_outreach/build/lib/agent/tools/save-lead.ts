import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed, refused } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query, one } from '../../db.ts';
import { normaliseDomain } from '../../domain.ts';
import { icpFingerprint } from '../../icp.ts';
import { parseHeadcount, statedBand, bandInsideBounds } from '../../providers/apify.ts';

/**
 * A size that only overlaps the ICP is not a size that qualifies.
 *
 * Discovery keeps anything overlapping the range, because LinkedIn's buckets
 * are coarse and requiring containment there would drop real companies before
 * anybody looked. The bill for that arrived on the lead list: against "10 to
 * 100", a company stating 2-10 employees came back qualified with its size
 * written up as a concern. A concern is what you file about something you have
 * judged. This is something nobody has resolved, and the verdict for that is
 * needs_review.
 *
 * Applied to the ceiling as well as the floor, for the same reason in the
 * other direction: a 51-200 band against 10 to 100 could be eighty people or
 * a hundred and eighty, and which one it is decides whether the lead belongs
 * on the list at all.
 *
 * It downgrades rather than refusing. The agent's reasoning is not wrong, it
 * is incomplete, and the fit reasons it wrote are exactly what the person
 * checking the size wants to read.
 */
function headcountDowngrade(
  meta: Record<string, unknown> | null, icp: Record<string, unknown> | null,
): string | null {
  const bounds = parseHeadcount(
    typeof icp?.headcount_range === 'string' ? icp.headcount_range : undefined);
  const band = statedBand(meta);
  if (bandInsideBounds(band, bounds) !== false) return null;
  return `LinkedIn puts this company in the ${band!.start} to ${band!.end} employee band, ` +
    `which is not inside the ${bounds!.min} to ${bounds!.max} this ICP asks for. The two ` +
    'ranges overlap, which is why it was discovered, but overlapping is not meeting the ' +
    'filter. Confirm the real headcount before treating this as qualified.';
}

export const saveLead = tool(
  'save_lead',
  'Store your qualification verdict for one company, with the evidence it rests on. ' +
  'A qualified verdict requires at least one fit reason, at least one source URL this ' +
  'run actually retrieved, and confidence of 0.40 or higher.',
  {
    ...baseArgs,
    company_name: z.string(),
    company_domain: z.string(),
    qualification_status: z.enum(['qualified', 'not_qualified', 'needs_review']),
    confidence: z.number().min(0).max(1)
      .describe('Calibrated to the bands in the lead-qualification skill.'),
    fit_reasons: z.array(z.string())
      .describe('Each names the specific hard filter it satisfies and where that came from.'),
    concerns: z.array(z.string())
      .describe('An empty array is a claim that you looked and found none.'),
    source_urls: z.array(z.string())
      .describe('Pages this run actually scraped. Not pages you inferred exist.'),
    source_summary: z.string(),
  },
  async (args) => {
    try {
      return await withToolCall(args.run_id, 'save_lead', args.purpose, args, async () => {
        const domain = normaliseDomain(args.company_domain);
        if (!domain) {
          return {
            value: refused(`"${args.company_domain}" is not a usable company domain.`),
            resultSummary: { rejected: 'bad domain' },
          };
        }

        // Read the constraints back to the agent before the database does, so
        // the message names what is missing rather than quoting Postgres.
        if (args.qualification_status === 'qualified') {
          const missing: string[] = [];
          if (!args.fit_reasons.length) missing.push('fit_reasons is empty');
          if (!args.source_urls.length) missing.push('source_urls is empty');
          if (args.confidence < 0.4) {
            missing.push(`confidence ${args.confidence} is below the 0.40 floor for qualified`);
          }
          if (missing.length) {
            return {
              value: refused(
                `save_lead rejected for ${domain}: ${missing.join('; ')}. ` +
                'A qualified verdict has to carry the evidence a reviewer checks it against. ' +
                'Use needs_review if you do not have that evidence.'),
              resultSummary: { rejected: missing.join('; '), domain },
            };
          }

          // A source URL the run never fetched is a citation of a page that
          // may not exist. This is the check that stops that.
          const known = await query<{ url: string }>(
            'select url from public.scraped_pages where run_id = $1 and url = any($2)',
            [args.run_id, args.source_urls],
          );
          if (!known.length) {
            return {
              value: refused(
                `save_lead rejected for ${domain}: none of those source URLs were retrieved ` +
                'by this run. Cite pages you actually scraped.'),
              resultSummary: { rejected: 'unretrieved sources', domain },
            };
          }
        }

        /**
         * Read once, used twice: the size check below and the fingerprint
         * further down both want the ICP, and a second query for the same row
         * in the same call is a second chance for them to disagree.
         */
        const [runRow] = await query<{ icp: Record<string, unknown> | null }>(
          'select icp from public.runs where id = $1', [args.run_id]);

        let status = args.qualification_status;
        const concerns = [...args.concerns];
        let downgraded: string | null = null;

        if (status === 'qualified') {
          const [candidate] = await query<{ discovery_meta: Record<string, unknown> | null }>(
            `select discovery_meta from public.candidates
              where run_id = $1 and company_domain = $2`,
            [args.run_id, domain]);
          downgraded = headcountDowngrade(candidate?.discovery_meta ?? null, runRow?.icp ?? null);
          if (downgraded) {
            status = 'needs_review';
            concerns.push(downgraded);
          }
        }

        try {
          /**
           * The duplicate check IS the insert.
           *
           * Several verdicts now arrive in one turn, so a read followed by a
           * write is a race: two calls for the same domain both saw no row and
           * both inserted, and the loser came back as a raw unique-violation
           * rather than the sentence below. `on conflict do nothing` decides it
           * in one statement, and no rows returned means somebody else won.
           */
          const row = await one<{ id: string }>(
            `insert into public.leads
               (run_id, company_name, company_domain, qualification_status, confidence,
                fit_reasons, concerns, source_urls, source_summary)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (run_id, company_domain) do nothing
             returning id`,
            [args.run_id, args.company_name, domain, status,
             args.confidence, args.fit_reasons, concerns, args.source_urls,
             args.source_summary],
          );
          if (!row) {
            return {
              value: refused(
                `${domain} already has a stored verdict for this run. A company appears once.`),
              resultSummary: { rejected: 'duplicate', domain },
            };
          }
          await query(
            'update public.candidates set assessed = true where run_id = $1 and company_domain = $2',
            [args.run_id, domain],
          );

          /**
           * The judgement, kept beyond this run. Instrumentation only: nothing
           * reads this to decide anything, and it exists so the overlap
           * between runs can be measured before a reuse cache is built on the
           * assumption that overlap exists.
           *
           * A failure here must never lose the lead that was just stored, so
           * it is deliberately not allowed to throw.
           */
          try {
            await query(
              `insert into public.judged_companies
                 (company_domain, icp_fingerprint, verdict, run_id)
               values ($1,$2,$3,$4)
               on conflict (company_domain, icp_fingerprint) do update
                 set verdict = excluded.verdict,
                     run_id = excluded.run_id,
                     judged_at = now(),
                     -- The measurement: how many times this company has been
                     -- judged under these same criteria. Summed as
                     -- (times_judged - 1) it is the work a cache would skip.
                     times_judged = public.judged_companies.times_judged + 1`,
              [domain, icpFingerprint(runRow?.icp), status, args.run_id],
            );
          } catch {
            // Instrumentation must never cost a lead that is already stored.
          }
          return {
            // The downgrade is reported, not applied silently. An agent told
            // its verdict was stored as something else stops arguing with the
            // rule and stops re-sending the same company.
            value: ok({
              lead_id: row!.id, domain, status,
              ...(downgraded ? { downgraded_from: 'qualified', reason: downgraded } : {}),
            }),
            resultSummary: { domain, status, confidence: args.confidence,
                             ...(downgraded ? { downgraded: 'headcount' } : {}) },
          };
        } catch (e: any) {
          // The CHECK is the last line and it does not negotiate.
          if (String(e?.constraint) === 'leads_qualified_needs_evidence') {
            return {
              value: refused(
                'The database refused this lead: a qualified verdict needs at least one fit ' +
                'reason, at least one source URL and confidence of 0.40 or higher.'),
              resultSummary: { rejected: 'constraint', domain },
            };
          }
          throw e;
        }
      });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: false } },
);
