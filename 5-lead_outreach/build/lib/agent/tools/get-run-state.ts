import { tool } from '@anthropic-ai/claude-agent-sdk';
import { baseArgs, ok } from './shared.ts';
import { loadRun, runStats } from '../../runs.ts';
import { query } from '../../db.ts';
import { apifySpend } from '../../budget.ts';

/**
 * How the agent recovers after an error, and how it plans within its budget.
 *
 * This tool never fails. An agent that cannot find out what state it is in
 * has no way back to useful work, so a database problem returns a text result
 * saying so rather than an error the model has to guess around.
 */
export const getRunState = tool(
  'get_run_state',
  'Read the current state of this run: budgets remaining, how many leads are stored by ' +
  'status, which company domains have already been seen, and whether the run is waiting ' +
  'on an answer from the operator. Call this whenever you need to plan or after an error.',
  baseArgs,
  async (args) => {
    try {
      const run = await loadRun(args.run_id);
      const stats = await runStats(args.run_id);
      const domains = await query<{
        company_domain: string; company_name: string; assessed: boolean;
        discovery_meta: Record<string, unknown>;
      }>(
        `select company_domain, company_name, assessed, discovery_meta
           from public.candidates where run_id = $1`,
        [args.run_id],
      );

      return ok({
        status: run.status,
        objective: run.objective,
        icp_saved: run.icp !== null,
        needs_clarification: run.needs_clarification,
        target_leads: run.target_leads,
        candidates: {
          budget: run.candidate_budget,
          used: run.candidates_used,
          remaining: Math.max(0, run.candidate_budget - run.candidates_used),
          /**
           * What discovery already told us about each company it found.
           *
           * This is here so a candidate that fails a hard filter on its
           * metadata alone can be disqualified without spending a scrape on
           * it. Storing the metadata and never showing it to the agent meant
           * every candidate cost a page fetch to rule out.
           */
          unassessed: domains.filter((d) => !d.assessed).map((d) => ({
            domain: d.company_domain,
            name: d.company_name,
            from_discovery: d.discovery_meta,
          })),
        },
        scrapes: {
          budget: run.scrape_budget,
          used: run.scrapes_used,
          remaining: Math.max(0, run.scrape_budget - run.scrapes_used),
        },
        leads: stats,
        domains_seen: domains.map((d) => d.company_domain),
        apify_spend_usd: await apifySpend(args.run_id),
      });
    } catch (e) {
      return ok(
        'Run state is temporarily unavailable: ' +
        `${e instanceof Error ? e.message : String(e)}. ` +
        'Do not assume budget remains. Try this call once more before doing anything that spends.',
      );
    }
  },
  { annotations: { readOnlyHint: true, openWorldHint: false } },
);
