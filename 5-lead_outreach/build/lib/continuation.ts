import { randomUUID } from 'node:crypto';
import { tx } from './db.ts';
import { ProviderError } from './errors.ts';
import { config } from './config.ts';
import type { RunRow } from './runs.ts';

/**
 * Continue a run that fell short, rather than starting it again.
 *
 * A run that ends `partial` has already paid for an ICP that was worked out,
 * for every company it discovered, and for every verdict it reached. Starting
 * again from the objective re-derives the ICP, pays Apify to rediscover the
 * same companies and pays Claude to re-judge them.
 *
 * The child is a SEPARATE run with its own budgets. Reopening the parent would
 * make its `finished_at` a lie and its spend unattributable, and the spend
 * ledger is the one record this system asks people to trust.
 */
const TERMINAL = ['complete', 'partial', 'failed'];

export async function createContinuation(
  parentRunId: string, createdBy: string | null,
): Promise<RunRow> {
  return tx(async (client) => {
    const { rows } = await client.query<RunRow>(
      'select * from public.runs where id = $1 for update', [parentRunId]);
    const parent = rows[0];
    if (!parent) throw new ProviderError('CONTINUE_NO_RUN', 'No such run.');

    // Two runs working one ICP at once would double the spend and race each
    // other to the same companies.
    if (!TERMINAL.includes(parent.status)) {
      throw new ProviderError('CONTINUE_NOT_FINISHED',
        `This run is still ${parent.status.replace(/_/g, ' ')}. Wait for it to finish, ` +
        'then continue it.');
    }
    if (!parent.icp) {
      throw new ProviderError('CONTINUE_NO_ICP',
        'This run never settled on an ICP, so there is nothing to carry forward. ' +
        'Start a new run instead.');
    }

    const { rows: made } = await client.query<RunRow>(
      `insert into public.runs
         (idempotency_key, objective, icp, status, candidate_budget, scrape_budget,
          apify_cap_usd, target_leads, created_by, parent_run_id)
       values ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9)
       returning *`,
      [randomUUID(), parent.objective, parent.icp, config.limits.candidateBudget,
       config.limits.scrapeBudget, config.limits.runApifyCapUsd, parent.target_leads,
       createdBy ?? parent.created_by, parent.id],
    );
    const child = made[0];

    /**
     * Candidates the parent discovered and never got to.
     *
     * These were charged. Leaving them behind means the child pays Apify to
     * find the same companies again, which is the waste this whole thing
     * exists to stop. Anything the parent assessed stays behind: its verdict
     * already counts, and the delivered list keeps the qualified ones from
     * being handed over twice.
     */
    await client.query(
      `insert into public.candidates
         (run_id, company_name, company_domain, discovery_meta)
       select $1, company_name, company_domain, discovery_meta
         from public.candidates
        where run_id = $2 and assessed = false
       on conflict (run_id, company_domain) do nothing`,
      [child.id, parent.id],
    );

    return child;
  });
}
