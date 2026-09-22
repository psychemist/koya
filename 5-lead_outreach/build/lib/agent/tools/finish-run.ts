import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed, refused } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query } from '../../db.ts';
import { loadRun, runStats, transition } from '../../runs.ts';
import { recomputeScorecard } from '../../gates/list-quality.ts';

export const finishRun = tool(
  'finish_run',
  'End this run. The scorecard is recomputed from the stored rows and compared with ' +
  'what you report. If the two disagree the run is not marked complete, so report ' +
  'honestly. Returning fewer leads with a clear shortfall reason is a good outcome; ' +
  'padding the list is not.',
  {
    ...baseArgs,
    claimed_qualified: z.number().int().min(0)
      .describe('How many qualified leads you believe are stored.'),
    summary: z.string().describe('What you did and what a reviewer should look at first.'),
    shortfall_reason: z.string().optional()
      .describe('Required when you are short of the target. Name which budget ran out and ' +
                'how many candidates you assessed.'),
  },
  async (args) => {
    try {
      return await withToolCall(args.run_id, 'finish_run', args.purpose, args, async () => {
        const run = await loadRun(args.run_id);
        const stats = await runStats(args.run_id);

        // Recomputed in code rather than trusting the agent's account of it.
        if (stats.qualified !== args.claimed_qualified) {
          return {
            value: refused(
              `The recount disagrees: you claimed ${args.claimed_qualified} qualified leads ` +
              `and ${stats.qualified} are stored. Call get_run_state, reconcile, and try again.`),
            resultSummary: { rejected: 'recount', claimed: args.claimed_qualified,
                             actual: stats.qualified },
          };
        }

        // The six dimensions the lead-list-quality skill says are recomputed
        // here. A list that fails one is not a finished list, however many
        // rows it has.
        const scorecard = await recomputeScorecard(args.run_id);
        if (!scorecard.passed) {
          const failures = scorecard.dimensions.filter((d) => !d.passed);
          return {
            value: refused(
              'The scorecard does not pass, so this run is not finished:\n' +
              failures.map((f) => `- ${f.dimension}: ${f.detail}`).join('\n') +
              '\nFix these and call finish_run again. Do not pad the list to compensate.'),
            resultSummary: { rejected: 'scorecard', failures: failures.map((f) => f.dimension) },
          };
        }

        const short = stats.qualified < run.target_leads;
        if (short && !args.shortfall_reason) {
          return {
            value: refused(
              `Only ${stats.qualified} of ${run.target_leads} qualified leads are stored, so ` +
              'shortfall_reason is required. Name which budget ran out and how many ' +
              'candidates you assessed. Do not pad the list.'),
            resultSummary: { rejected: 'missing shortfall_reason' },
          };
        }

        const status = short ? 'partial' : 'complete';
        const moved = await transition(
          args.run_id,
          ['queued', 'refining_icp', 'discovering', 'researching', 'drafting'],
          status,
          undefined,
          {
            shortfall_reason: short ? args.shortfall_reason : null,
            finished_at: new Date(),
          },
        );
        if (!moved) {
          return {
            value: refused('This run is already finished. Nothing further to do.'),
            resultSummary: { rejected: 'already terminal' },
          };
        }

        // Delivered domains are recorded so a later run does not spend an
        // Apify item rediscovering a company already handed over.
        await query(
          `insert into public.delivered_domains (company_domain, first_run_id)
           select company_domain, $1 from public.leads
            where run_id = $1 and qualification_status = 'qualified'
           on conflict (company_domain) do nothing`,
          [args.run_id],
        );

        return {
          value: ok({
            status, qualified: stats.qualified, target: run.target_leads, stats,
            scorecard: scorecard.dimensions.map((d) => `${d.dimension}: ${d.detail}`),
          }),
          resultSummary: { status, ...stats },
        };
      });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: false } },
);
