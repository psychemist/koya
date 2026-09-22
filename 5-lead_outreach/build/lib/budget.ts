import { query, tx } from './db.ts';
import { config } from './config.ts';
import { ProviderError } from './errors.ts';
import type { RunRow } from './runs.ts';

/**
 * The clamp.
 *
 * `requested` exists only so a caller that passes one cannot get more than the
 * run allows. The tools do not expose a count to the model at all, so in
 * practice this is called with no argument and returns what is left.
 */
export function clampCandidates(run: Pick<RunRow, 'candidate_budget' | 'candidates_used'>,
                                requested?: number): number {
  const remaining = Math.max(0, run.candidate_budget - run.candidates_used);
  if (requested === undefined || !Number.isFinite(requested)) return remaining;
  return Math.max(0, Math.min(Math.floor(requested), remaining));
}

export function clampScrapes(run: Pick<RunRow, 'scrape_budget' | 'scrapes_used'>,
                             requested?: number): number {
  const remaining = Math.max(0, run.scrape_budget - run.scrapes_used);
  if (requested === undefined || !Number.isFinite(requested)) return remaining;
  return Math.max(0, Math.min(Math.floor(requested), remaining));
}

/** One advisory lock key for the whole spend ledger, so the check and the
 *  reservation below cannot interleave with another worker's. */
const SPEND_LOCK = 8_150_2026;

type Spend = { run_total: string | null; day_total: string | null };

async function totals(client: { query: Function }, runId: string): Promise<Spend> {
  const res = await client.query(
    `select (select coalesce(sum(amount_usd),0) from public.spend_ledger
              where run_id = $1 and provider = 'apify')::text as run_total,
            (select coalesce(sum(amount_usd),0) from public.spend_ledger
              where provider = 'apify'
                and created_at >= date_trunc('day', now() at time zone 'utc'))::text as day_total`,
    [runId],
  );
  return res.rows[0] as Spend;
}

export type SpendReservation = { ledgerId: string };

/**
 * Check and reserve in one transaction.
 *
 * Checking without reserving is how two concurrent runs both pass a check that
 * only one of them should have. The estimate goes into the ledger immediately
 * and `settleSpend` replaces it with the amount the provider actually
 * reported, so the cap holds even while a call is still in flight.
 */
export async function reserveApifySpend(
  runId: string, estimateUsd: number, note: string,
): Promise<SpendReservation> {
  try {
    return await reserve(runId, estimateUsd, note);
  } catch (e) {
    // The daily cap is drawn against a shared cohort account, so the next
    // person is already blocked. Somebody should know within seconds rather
    // than at the end of a run.
    if (e instanceof ProviderError && e.code === 'BUDGET_DAY') {
      const { notify, operatorRecipients } = await import('./notify/index.ts');
      await notify({
        kind: 'budget_exhausted_daily',
        runId,
        scope: new Date().toISOString().slice(0, 10),
        title: 'Koya Lead Desk: daily Apify cap reached',
        lines: [e.message, 'This account is shared across the cohort.'],
        to: operatorRecipients(),
      });
    }
    throw e;
  }
}

async function reserve(
  runId: string, estimateUsd: number, note: string,
): Promise<SpendReservation> {
  return tx(async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [SPEND_LOCK]);
    const t = await totals(client, runId);
    const runSpent = Number(t.run_total ?? 0);
    const daySpent = Number(t.day_total ?? 0);

    if (runSpent + estimateUsd > config.limits.runApifyCapUsd) {
      throw new ProviderError('BUDGET_RUN',
        `This run has spent $${runSpent.toFixed(4)} on discovery and the cap is ` +
        `$${config.limits.runApifyCapUsd.toFixed(2)}. Work with the candidates you have.`);
    }
    if (daySpent + estimateUsd > config.limits.dailyApifyCapUsd) {
      throw new ProviderError('BUDGET_DAY',
        `The daily Apify cap of $${config.limits.dailyApifyCapUsd.toFixed(2)} is reached. ` +
        'This account is shared across the cohort, so no further discovery runs today.');
    }

    const res = await client.query(
      `insert into public.spend_ledger (run_id, provider, amount_usd, note)
       values ($1, 'apify', $2, $3) returning id`,
      [runId, estimateUsd, `reserved: ${note}`],
    );
    return { ledgerId: res.rows[0].id as string };
  });
}

/**
 * The ledger is the source of truth; the columns on `runs` are a cache of it.
 *
 * They exist because the digest, the run list and the sample pack all read
 * cost from the run rather than re-aggregating, and a cache nobody refreshes
 * reads $0.00 forever, which is worse than no figure at all.
 */
async function syncRunSpend(runId: string | null): Promise<void> {
  if (!runId) return;
  await query(
    `update public.runs set
       apify_spend_usd = (select coalesce(sum(amount_usd),0) from public.spend_ledger
                           where run_id = $1 and provider = 'apify'),
       claude_cost_usd = (select coalesce(sum(amount_usd),0) from public.spend_ledger
                           where run_id = $1 and provider = 'claude')
     where id = $1`,
    [runId],
  ).catch(() => undefined);
}

/** Replace a reservation with what the provider actually charged. */
export async function settleSpend(
  ledgerId: string, actualUsd: number, note: string,
): Promise<void> {
  const [row] = await query<{ run_id: string | null }>(
    'update public.spend_ledger set amount_usd = $2, note = $3 where id = $1 returning run_id',
    [ledgerId, actualUsd, note],
  );
  await syncRunSpend(row?.run_id ?? null);
}

export async function recordSpend(
  runId: string | null, provider: 'apify' | 'claude' | 'firecrawl',
  amountUsd: number, note: string,
): Promise<void> {
  await query(
    'insert into public.spend_ledger (run_id, provider, amount_usd, note) values ($1,$2,$3,$4)',
    [runId, provider, amountUsd, note],
  );
  await syncRunSpend(runId);
}

export async function apifySpend(runId: string): Promise<number> {
  const [row] = await query<{ total: string }>(
    `select coalesce(sum(amount_usd),0)::text as total from public.spend_ledger
      where run_id = $1 and provider = 'apify'`,
    [runId],
  );
  return Number(row?.total ?? 0);
}
