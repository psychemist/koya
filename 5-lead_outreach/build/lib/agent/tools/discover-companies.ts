import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query } from '../../db.ts';
import { loadRun } from '../../runs.ts';
import { clampCandidates, discoveryCallsLeft } from '../../budget.ts';
import { ProviderError } from '../../errors.ts';
import {
  discover, headcountBuckets, parseHeadcount, type Candidate,
} from '../../providers/apify.ts';
import { industryIds } from '../../industries.ts';

/**
 * Stores what discovery found, minus everything it should not cost us to look at.
 *
 * Delivered domains are excluded HERE rather than after scraping, because a
 * company we already handed over should not consume a scrape to rediscover.
 */
async function storeCandidates(runId: string, found: Candidate[]) {
  if (!found.length) return [];
  const domains = found.map((c) => c.companyDomain);

  const delivered = new Set(
    (await query<{ company_domain: string }>(
      'select company_domain from public.delivered_domains where company_domain = any($1)',
      [domains],
    )).map((r) => r.company_domain),
  );

  const stored: Candidate[] = [];
  for (const c of found) {
    if (delivered.has(c.companyDomain)) continue;
    const rows = await query(
      `insert into public.candidates (run_id, company_name, company_domain, discovery_meta)
       values ($1,$2,$3,$4)
       on conflict (run_id, company_domain) do nothing
       returning id`,
      [runId, c.companyName, c.companyDomain, JSON.stringify(c.meta)],
    );
    if (rows.length) stored.push(c);
  }
  return stored;
}

export const discoverCompanies = tool(
  'discover_companies',
  'Search for candidate companies matching a query. The number of results is set ' +
  'by the run budget, not by you. Returns company names and domains.',
  {
    ...baseArgs,
    query: z.string().describe('The search query you composed from the refined ICP.'),
  },
  async (args) => {
    try {
      return await withToolCall(args.run_id, 'discover_companies', args.purpose, args,
        async () => {
          const run = await loadRun(args.run_id);
          // NOTE: no count argument from the model exists. The limit comes
          // from the row, so there is nothing for the agent to inflate.
          const limit = clampCandidates(run);
          if (limit === 0) {
            throw new ProviderError('BUDGET_RUN',
              'Candidate budget is exhausted. Work with the candidates you already have, ' +
              'and finish the run with a shortfall reason if you cannot reach the target.');
          }

          /**
           * The ICP's hard filters go to the actor as FILTERS, not as words in
           * the query. LinkedIn reads `searchQuery` as free text, so a query
           * naming a country and a headcount returns companies matching
           * neither. These come from the stored row rather than from the
           * agent's argument, so they are the criteria that were actually
           * agreed and written down.
           */
          /**
           * Searches are budgeted separately from candidates.
           *
           * Every search pays a start fee whatever it returns, and every one
           * adds a turn to a transcript that all later turns pay to re-send.
           * The run of 2026-09-25 made twenty-one for forty rows, three of its
           * first six returning nothing. The row for THIS call is already
           * inserted but not yet 'ok', so it is not counted against itself.
           */
          const [prior] = await query<{ n: string }>(
            `select count(*)::text as n from public.tool_calls
              where run_id = $1 and tool_name = 'discover_companies' and status = 'ok'`,
            [args.run_id],
          );
          const searchesLeft = discoveryCallsLeft(Number(prior?.n ?? 0));
          if (searchesLeft === 0) {
            throw new ProviderError('BUDGET_RUN',
              `This run has already paid for ${prior?.n ?? 0} searches, which is the limit. ` +
              'Work with the candidates you already have. If they are too few, finish the run ' +
              'with a shortfall reason naming this limit rather than searching again.');
          }

          const icp = (run.icp ?? {}) as {
            geography?: string[]; headcount_range?: string; industries?: string[];
          };

          /**
           * Industry is the filter that separates a B2B SaaS company from the
           * consultancy that sells to one. Both match the words "B2B SaaS" in
           * a free-text query, and only the industry id tells them apart.
           */
          const industry = industryIds(icp.industries);

          const filters = {
            locations: Array.isArray(icp.geography) ? icp.geography : [],
            companySize: headcountBuckets(icp.headcount_range),
            industryIds: industry.ids,
          };

          /**
           * The buckets requested above are wider than the range the ICP
           * stated, because "10 to 100" spans three of LinkedIn's, so the
           * stated size is re-checked on the rows that come back.
           */
          const headcount = parseHeadcount(icp.headcount_range);

          const { candidates, itemsCharged, dropped } =
            await discover(args.run_id, args.query, limit, { filters, headcount });
          const stored = await storeCandidates(args.run_id, candidates);

          await query(
            'update public.runs set candidates_used = candidates_used + $2 where id = $1',
            [args.run_id, itemsCharged],
          );

          return {
            value: ok({
              stored: stored.map((c) => ({ name: c.companyName, domain: c.companyDomain })),
              returned: candidates.length,
              skipped_already_delivered: candidates.length - stored.length,
              candidate_budget_remaining: Math.max(0, limit - itemsCharged),
              /** Searches, not candidates. Spend them on a WIDER query rather
               *  than a narrower retry: a search that returned nothing was too
               *  narrow, and narrowing it further returns nothing again. */
              searches_left: searchesLeft - 1,
              ...(candidates.length === 0
                ? { hint: 'This search returned nothing usable and still cost a start fee. ' +
                          'Widen the query before trying again, and check ' +
                          'icp_industries_not_filtered below.' }
                : {}),
              /**
               * Charged and then discarded. Given to the model so that a query
               * returning mostly unusable rows can be narrowed on the next
               * call rather than repeated until the budget is gone.
               */
              charged_but_dropped: dropped,
              /**
               * An ICP industry with no LinkedIn equivalent is NOT being
               * filtered on, and saying so is the difference between the model
               * trusting the result and the model checking it.
               */
              ...(industry.unmatched.length
                ? { icp_industries_not_filtered: industry.unmatched }
                : {}),
            }),
            resultSummary: {
              requested: limit, returned: candidates.length, stored: stored.length,
              charged: itemsCharged,
            },
          };
        });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: true } },
);
