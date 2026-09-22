import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed, refused } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query } from '../../db.ts';
import { loadRun } from '../../runs.ts';
import { notify, operatorRecipients } from '../../notify/index.ts';

/** Mirrors the shape the icp-refinement skill is told to produce, so the agent
 *  knows the contract rather than discovering it through a rejection. */
const icpSchema = {
  ...baseArgs,
  target_company_type: z.string(),
  industries: z.array(z.string()),
  geography: z.array(z.string()),
  headcount_range: z.string(),
  buyer_persona: z.string(),
  business_problem: z.string(),
  hard_filters: z.array(z.string())
    .describe('Criteria that must be true or the lead does not qualify. Must not be empty.'),
  soft_preferences: z.array(z.string()),
  disqualifiers: z.array(z.string()),
  needs_clarification: z.string().optional()
    .describe('Set this to one specific question when the objective is too vague to search. ' +
              'The run parks and nothing is spent.'),
};

export const saveIcp = tool(
  'save_icp',
  'Store the refined ICP for this run. This must happen before any discovery call, ' +
  'because discovery costs money and a bad ICP spends it on the wrong companies. If the ' +
  'objective is too vague even after refinement, set needs_clarification instead of guessing.',
  icpSchema,
  async (args) => {
    try {
      return await withToolCall(args.run_id, 'save_icp', args.purpose, args, async () => {
        // Parking is a legitimate outcome and costs nothing, so it is allowed
        // to skip the hard_filters requirement that a searchable ICP has.
        if (args.needs_clarification) {
          const run = await loadRun(args.run_id);
          await query(
            `update public.runs set needs_clarification = $2, status = 'refining_icp'
              where id = $1`,
            [args.run_id, args.needs_clarification],
          );

          /**
           * Emitted here rather than at the end of the loop, because this is
           * the one gate where nothing proceeds until a person answers and
           * telling them when the agent finally unwinds is telling them late.
           *
           * This is not a tool the agent can choose to call: it is a fixed
           * consequence of a database write, on our side of the boundary. The
           * agent still has no way to compose or address a message.
           */
          await notify({
            kind: 'run_needs_clarification',
            runId: args.run_id,
            title: 'Koya Lead Desk: a run is waiting on you',
            lines: [`Objective: ${run.objective}`, args.needs_clarification],
            to: operatorRecipients(),
          });

          return {
            value: ok('Run parked awaiting an operator answer. Stop here. Do not spend. ' +
                      'The tools that cost money are now closed to you for this run.'),
            resultSummary: { parked: true },
          };
        }

        if (!args.hard_filters.length) {
          return {
            value: refused(
              'save_icp rejected: hard_filters is empty. An ICP with no hard filter cannot ' +
              'disqualify anything, so every company would pass. Name the criteria that must ' +
              'be true, or set needs_clarification if the objective does not support any.'),
            resultSummary: { rejected: 'empty hard_filters' },
          };
        }

        const { run_id, purpose, needs_clarification, ...icp } = args;
        const run = await loadRun(run_id);
        await query(
          `update public.runs
              set icp = $2, needs_clarification = null,
                  status = case when status = 'refining_icp' then 'discovering' else status end
            where id = $1`,
          [run_id, JSON.stringify(icp)],
        );
        return {
          value: ok({
            saved: true,
            hard_filters: icp.hard_filters.length,
            candidate_budget_remaining: Math.max(0, run.candidate_budget - run.candidates_used),
          }),
          resultSummary: { hard_filters: icp.hard_filters.length },
        };
      });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: false } },
);
