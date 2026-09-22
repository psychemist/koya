import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseArgs, ok, failed } from './shared.ts';
import { withToolCall } from '../../toolcalls.ts';
import { query } from '../../db.ts';
import { loadRun } from '../../runs.ts';
import { clampCandidates } from '../../budget.ts';
import { ProviderError } from '../../errors.ts';
import { discover, type Candidate } from '../../providers/apify.ts';

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

          const { candidates, itemsCharged } = await discover(args.run_id, args.query, limit);
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
            }),
            resultSummary: {
              requested: limit, returned: candidates.length, stored: stored.length,
            },
          };
        });
    } catch (e) {
      return failed(e);
    }
  },
  { annotations: { readOnlyHint: false, openWorldHint: true } },
);
