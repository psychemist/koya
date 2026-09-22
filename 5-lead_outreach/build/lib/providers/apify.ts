import { ApifyClient } from 'apify-client';
import { config } from '../config.ts';
import { ProviderError } from '../errors.ts';
import { normaliseDomain } from '../domain.ts';
import { reserveApifySpend, settleSpend } from '../budget.ts';

export type Candidate = {
  companyName: string;
  companyDomain: string;
  meta: Record<string, unknown>;
};

let client: ApifyClient | null = null;
export function apify(): ApifyClient {
  if (!client) client = new ApifyClient({ token: config.apifyToken() });
  return client;
}

/**
 * Every Apify call carries a hard stop.
 *
 * `maxItems` is documented as the cap on CHARGED dataset items for a
 * pay-per-result actor, and `maxTotalChargeUsd` terminates the run gracefully
 * rather than letting it keep spending. There is no code path that omits
 * either, which is why the limit is an argument this function refuses to be
 * called without.
 */
export function buildActorInput(queryText: string, limit: number) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    throw new ProviderError('BUDGET_RUN',
      'Refusing to start an Apify run with no candidate budget left.');
  }
  return {
    query: queryText,
    maxItems: Math.floor(limit),
    maxTotalChargeUsd: config.limits.runApifyCapUsd,
  };
}

/** Actors disagree on field names, so read the plausible ones and drop the row
 *  if none of them yields a domain. A candidate without a domain is not a
 *  candidate; it is a row that will waste a scrape. */
export function toCandidate(item: Record<string, unknown>): Candidate | null {
  const raw = (item.website ?? item.url ?? item.domain ?? item.link ?? item.companyUrl) as
    string | undefined;
  if (typeof raw !== 'string') return null;
  const companyDomain = normaliseDomain(raw);
  if (!companyDomain) return null;

  const name = (item.name ?? item.title ?? item.companyName ?? item.company) as string | undefined;
  const { website, url, domain, link, companyUrl, name: _n, title: _t, ...meta } = item as any;
  return {
    companyName: (typeof name === 'string' && name.trim()) || companyDomain,
    companyDomain,
    meta: meta as Record<string, unknown>,
  };
}

/**
 * An actor left running is an actor still spending, so an overrun is aborted
 * rather than waited out.
 */
async function waitOrAbort(runId: string, wallClockMs: number) {
  const started = Date.now();
  for (;;) {
    const run = await apify().run(runId).get();
    if (!run) throw new ProviderError('APIFY_LOST', `Apify run ${runId} disappeared.`);
    if (run.status !== 'RUNNING' && run.status !== 'READY') return run;
    if (Date.now() - started > wallClockMs) {
      await apify().run(runId).abort().catch(() => undefined);
      throw new ProviderError('APIFY_ABORTED',
        `Apify run ${runId} passed its wall clock and was aborted.`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export type Discovery = {
  candidates: Candidate[];
  /** Raw dataset rows. These were charged whether or not they deduplicated
   *  away, so this is the number that decrements the candidate budget. */
  itemsCharged: number;
};

export async function discover(
  runId: string, queryText: string, limit: number,
): Promise<Discovery> {
  const input = buildActorInput(queryText, limit);
  const estimate = limit * config.limits.apifyPricePerResultUsd;
  const actorId = config.pinnedActorId();

  // Reserve before calling. A check that does not reserve is a check two
  // concurrent runs can both pass.
  const reservation = await reserveApifySpend(runId, estimate, `actor=${actorId}`);

  let started;
  try {
    started = await apify().actor(actorId).start(input, { memory: 1024, timeout: 180 });
  } catch (e: any) {
    await settleSpend(reservation.ledgerId, 0, 'actor failed to start, nothing charged');
    const status = e?.statusCode ?? e?.status;
    throw new ProviderError(
      status === 429 ? 'APIFY_429' : status >= 500 ? 'APIFY_5XX' : 'APIFY_START_FAILED',
      `Apify actor ${actorId} did not start: ${e?.message ?? e}`,
      status === 429 || status >= 500,
    );
  }

  const finished = await waitOrAbort(started.id, 200_000);
  const { items } = await apify().dataset(finished.defaultDatasetId).listItems();

  const charged = (finished as any).usageTotalUsd;
  await settleSpend(
    reservation.ledgerId,
    typeof charged === 'number' ? charged : items.length * config.limits.apifyPricePerResultUsd,
    `actor=${actorId} runId=${finished.id} items=${items.length}`,
  );

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const c = toCandidate(item);
    if (!c || seen.has(c.companyDomain)) continue;
    seen.add(c.companyDomain);
    out.push(c);
  }
  return { candidates: out, itemsCharged: items.length };
}

/**
 * Caught at boot, not in the billing summary.
 *
 * The cohort account is shared and the budget is $5 a person. A personal token
 * here means someone else's share is being spent, and the only cheap moment to
 * notice is before any run starts.
 */
export async function assertApifyAccount(): Promise<string> {
  const me = await apify().user('me').get();
  const name = (me as any)?.username ?? '(unknown)';
  const expected = config.apifyExpectedAccount;
  if (expected && name !== expected) {
    throw new Error(
      `APIFY_TOKEN belongs to "${name}" but APIFY_EXPECTED_ACCOUNT is "${expected}". ` +
      'Switch to the team account in the Apify Console and generate a team token.',
    );
  }
  return name;
}
