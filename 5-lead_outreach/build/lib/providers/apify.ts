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

export type ActorCall = {
  /** Sent verbatim as the actor's own input. */
  input: { query: string };
  /** Sent as ActorStartOptions, which is where Apify reads the caps. */
  options: {
    memory: number; timeout: number; maxItems: number; maxTotalChargeUsd: number;
  };
};

/**
 * Every Apify call carries a hard stop.
 *
 * `maxItems` caps CHARGED dataset items for a pay-per-result actor and
 * `maxTotalChargeUsd` caps a pay-per-event one. Both are ActorStartOptions,
 * NOT actor input: the client validates the options object against an exact
 * shape and builds the query string from it, so a cap written into the input
 * is handed to the actor as an unrecognised field and enforced by nobody.
 * That is a silent failure, which is why input and options are built together
 * here rather than assembled at the call site.
 */
export function buildActorCall(queryText: string, limit: number): ActorCall {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    throw new ProviderError('BUDGET_RUN',
      'Refusing to start an Apify run with no candidate budget left.');
  }
  return {
    input: { query: queryText },
    options: {
      memory: 1024,
      timeout: 180,                 // seconds. An actor left running is an actor still spending.
      maxItems: Math.floor(limit),
      maxTotalChargeUsd: config.limits.runApifyCapUsd,
    },
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

const START_ATTEMPTS = 3;

/**
 * Bounded retries with jittered backoff, for rate limits and 5xx only.
 *
 * The jitter matters because the cohort shares one Apify account: a fixed
 * backoff makes every worker that got a 429 come back at the same instant and
 * rate-limit each other again. Nothing else is retried, because a 4xx that is
 * not a 429 means the request was wrong and sending it again will not fix it.
 *
 * The retry lives here rather than being left to the agent. `ProviderError`
 * used to tell the model "this is transient, you may try once more", which
 * delegates a backoff decision to something with no clock.
 */
async function startWithBackoff(api: ApifyLike, actorId: string, call: ActorCall) {
  let lastError: any;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      return await api.actor(actorId).start(call.input, call.options);
    } catch (e: any) {
      lastError = e;
      const status = e?.statusCode ?? e?.status;
      const worthRetrying = status === 429 || (typeof status === 'number' && status >= 500);
      if (!worthRetrying || attempt === START_ATTEMPTS) throw e;
      const base = 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, base + Math.random() * base));
    }
  }
  throw lastError;
}

/**
 * An actor left running is an actor still spending, so an overrun is aborted
 * rather than waited out.
 */
async function waitOrAbort(api: ApifyLike, runId: string, wallClockMs: number) {
  const started = Date.now();
  for (;;) {
    const run = await api.run(runId).get();
    if (!run) throw new ProviderError('APIFY_LOST', `Apify run ${runId} disappeared.`);
    if (run.status !== 'RUNNING' && run.status !== 'READY') return run;
    if (Date.now() - started > wallClockMs) {
      await api.run(runId).abort().catch(() => undefined);
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

/**
 * The slice of the Apify client this module uses.
 *
 * Injectable so a test can assert on the two arguments `.start()` receives
 * without reaching the network. That distinction is the whole point here: the
 * caps were once built correctly and passed as argument one, where the
 * platform discards them, and no test that examined our own return value
 * could tell. A test must also never be able to spend from the shared cohort
 * account by accident.
 */
export type ApifyLike = {
  actor(id: string): { start(input: unknown, options: unknown): Promise<any> };
  run(id: string): { get(): Promise<any>; abort(): Promise<any> };
  dataset(id: string): { listItems(): Promise<{ items: unknown[] }> };
};

export async function discover(
  runId: string, queryText: string, limit: number,
  opts: { client?: ApifyLike; wallClockMs?: number } = {},
): Promise<Discovery> {
  const api: ApifyLike = opts.client ?? (apify() as unknown as ApifyLike);
  const wallClockMs = opts.wallClockMs ?? 200_000;
  const call = buildActorCall(queryText, limit);
  const estimate = limit * config.limits.apifyPricePerResultUsd;
  const actorId = config.pinnedActorId();

  // Reserve before calling. A check that does not reserve is a check two
  // concurrent runs can both pass.
  const reservation = await reserveApifySpend(runId, estimate, `actor=${actorId}`);

  /**
   * A reservation that is never replaced is a lie the ledger keeps telling.
   *
   * Every exit from this function settles exactly once. The path that matters
   * is the abort: a run that overran its wall clock is the one most likely to
   * have spent MORE than the estimate, so leaving the estimate in place would
   * understate the shared daily cap for everybody else.
   */
  let settled = false;
  const settle = async (usd: number, note: string) => {
    if (settled) return;
    settled = true;
    await settleSpend(reservation.ledgerId, usd, note).catch(() => undefined);
  };

  let started;
  try {
    started = await startWithBackoff(api, actorId, call);
  } catch (e: any) {
    await settle(0, 'actor failed to start, nothing charged');
    const status = e?.statusCode ?? e?.status;
    throw new ProviderError(
      status === 429 ? 'APIFY_429' : status >= 500 ? 'APIFY_5XX' : 'APIFY_START_FAILED',
      `Apify actor ${actorId} did not start after ${START_ATTEMPTS} attempts: ${e?.message ?? e}`,
      false,   // the retries have already happened; the agent must not add more
    );
  }

  let finished;
  let items: unknown[];
  try {
    finished = await waitOrAbort(api, started.id, wallClockMs);
    ({ items } = await api.dataset(finished.defaultDatasetId).listItems());
  } catch (e) {
    // Ask Apify what the run actually cost before giving up on it. If even
    // that fails, the estimate stands rather than being zeroed: an unknown
    // spend must not read as no spend.
    const reported = await api.run(started.id).get()
      .then((r) => (r as any)?.usageTotalUsd)
      .catch(() => undefined);
    await settle(
      typeof reported === 'number' ? reported : estimate,
      typeof reported === 'number'
        ? `actor=${actorId} runId=${started.id} did not complete, charged as reported`
        : `actor=${actorId} runId=${started.id} did not complete, usage unknown, estimate held`,
    );
    throw e;
  }

  const charged = (finished as any).usageTotalUsd;
  await settle(
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
