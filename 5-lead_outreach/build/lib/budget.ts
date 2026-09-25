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

/** What Claude has cost across every run today, from the ledger rather than
 *  the denormalised column, because the column is a cache of it. */
export async function claudeSpentToday(): Promise<number> {
  const [row] = await query<{ total: string }>(
    `select coalesce(sum(amount_usd),0)::text as total from public.spend_ledger
      where provider = 'claude'
        and created_at >= date_trunc('day', now() at time zone 'utc')`,
  );
  return Number(row?.total ?? 0);
}

/**
 * Whether the day can still fund a whole agent run.
 *
 * Apify is capped per run and per day. Claude, which is roughly 89% of what a
 * run costs, was capped only per run, so nothing bounded a day's spend at all.
 *
 * A whole run's ceiling is reserved rather than waiting for the day to cross
 * the line, because a cap that a single run can overshoot by its full budget
 * is not a cap. A figure that cannot be read fails closed: a glitched query
 * must not read as an empty day.
 *
 * Returns the refusal to show a person, or null when the run may start.
 */
export function dailyClaudeRefusal(daySpentUsd: number): string | null {
  const cap = config.limits.dailyClaudeCapUsd;
  const spent = Number(daySpentUsd);
  if (!Number.isFinite(spent) || spent < 0) {
    return `The day's Claude spend could not be read, so this run is not starting. ` +
      `The daily cap is $${cap.toFixed(2)}.`;
  }
  if (spent + config.limits.maxBudgetUsd > cap) {
    return `The daily Claude cap of $${cap.toFixed(2)} cannot fund another run today: ` +
      `$${spent.toFixed(2)} is already spent and one run may cost up to ` +
      `$${config.limits.maxBudgetUsd.toFixed(2)}. This account is shared, so no further ` +
      'runs start until tomorrow.';
  }
  return null;
}

/**
 * How many more searches this run may pay to start.
 *
 * Every search costs a start fee whatever it returns, and more importantly
 * every one adds a turn to a transcript that all later turns pay to re-send.
 * The run of 2026-09-25 made twenty-one, three of its first six returning
 * nothing at all.
 *
 * A count we could not read yields the full allowance rather than none: a
 * failed query must not silently hand out an unbounded one.
 */
export function discoveryCallsLeft(used: number): number {
  const n = Number(used);
  if (!Number.isFinite(n) || n < 0) return config.limits.discoveryCalls;
  return Math.max(0, config.limits.discoveryCalls - Math.floor(n));
}

/**
 * How many qualified leads this run is being asked for.
 *
 * `runs.target_leads` was read by the prompt, `get_run_state` and
 * `finish_run` from the start, but nothing ever wrote it, so every run used
 * the column default and a requester could not ask for a number.
 *
 * The ceiling is deliberate and the budgets behind it stay fixed. A narrow
 * ICP cannot be made productive by spending more on it: one discovery query
 * in the run of 2026-09-25 returned nineteen companies in total. Asking for
 * more than a run can reach is answered by `finish_run` demanding a shortfall
 * reason, which is honest, rather than by a budget that grows to chase it.
 */
const MAX_TARGET_LEADS = 25;

export function clampTargetLeads(requested: unknown): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) {
    return requested === undefined || requested === null || requested === ''
      || !Number.isFinite(n)
      ? config.limits.targetLeads
      : 1;
  }
  return Math.min(n, MAX_TARGET_LEADS);
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
  /** For a provider billed in credits rather than dollars. On the free
   *  Firecrawl plan $0.00 is the correct dollar figure and the credits are
   *  the only number that means anything. */
  credits = 0,
): Promise<void> {
  await query(
    `insert into public.spend_ledger (run_id, provider, amount_usd, note, credits)
     values ($1,$2,$3,$4,$5)`,
    [runId, provider, amountUsd, note, credits],
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
