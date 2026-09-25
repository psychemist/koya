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
 * The ICP's hard filters, in the shape the pinned actor accepts.
 *
 * These are filters, not keywords. LinkedIn treats `searchQuery` as free text:
 * a smoke run asking for "US B2B SaaS companies 10-100 employees" returned
 * eight results, the first being a UK IT consultancy, because none of the
 * constraints in that sentence were applied as constraints.
 */
/** `searchQuery` maxLength, from the pinned actor's input schema. */
const MAX_QUERY_CHARS = 300;

export type DiscoveryFilters = {
  locations?: string[];
  companySize?: string[];
  /** LinkedIn industry ids, resolved from the ICP's industry names by
   *  `industries.ts`. The single filter that separates a B2B SaaS company from
   *  a consultancy that sells to one. */
  industryIds?: string[];
};

export type ActorCall = {
  /** Sent verbatim as the actor's own input. Shaped for the pinned actor. */
  input: {
    searchQuery: string;
    scraperMode: 'short' | 'full';
    maxItems: number;
    locations?: string[];
    companySize?: string[];
    industryIds?: string[];
  };
  /** Sent as ActorStartOptions, which is where Apify reads the billing caps. */
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
export function buildActorCall(
  queryText: string, limit: number, filters: DiscoveryFilters = {},
): ActorCall {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    throw new ProviderError('BUDGET_RUN',
      'Refusing to start an Apify run with no candidate budget left.');
  }
  const capped = Math.floor(limit);
  return {
    // Field names are the pinned actor's own. The first smoke run sent a
    // field called `query` and the actor answered "No search parameters
    // provided, exiting": a wrong key is not an error, it is an empty run.
    input: {
      // maxLength 300 in the actor's input schema. The agent writes this
      // string and nothing else bounds it, and an input the schema rejects is
      // a run that fails to start after the start fee is already owed.
      searchQuery: queryText.slice(0, MAX_QUERY_CHARS),
      // Full mode, and the extra cost is not optional. Short mode returns
      // id, universalName, linkedinUrl, name, industry, location, followers,
      // summary and logo. No website, and a LinkedIn profile URL is not a
      // company to research: it is rejected as an aggregator, so every row
      // from short mode is dropped. Full mode adds website, employeeCount,
      // employeeCountRange, industries, specialities and description, which
      // is also the metadata that disqualifies a company without a scrape.
      scraperMode: 'full',
      ...(filters.locations?.length ? { locations: filters.locations } : {}),
      ...(filters.companySize?.length ? { companySize: filters.companySize } : {}),
      ...(filters.industryIds?.length ? { industryIds: filters.industryIds } : {}),
      // The scraper's own stop. It appears in BOTH places on purpose: this one
      // makes the actor stop collecting, and the one in `options` below makes
      // Apify stop charging. They are different mechanisms and a pay-per-event
      // actor needs both.
      maxItems: capped,
    },
    options: {
      memory: 1024,
      timeout: 180,                 // seconds. An actor left running is an actor still spending.
      maxItems: capped,
      maxTotalChargeUsd: config.limits.runApifyCapUsd,
    },
  };
}

/**
 * What a run is known to have cost, at minimum.
 *
 * `usageTotalUsd` reads LOW at the moment a run finishes. A pay-per-event
 * actor's per-event charges are aggregated after the fact, so the smoke run of
 * 2026-09-24 that returned two `full-company` records reported $0.001, which
 * is the `apify-actor-start` fee on its own. The run before it reported $0.
 *
 * Settling at that figure records a run as very nearly free, and since the
 * ledger is what both `RUN_APIFY_CAP_USD` and the shared `DAILY_APIFY_CAP_USD`
 * are measured against, believing it leaves neither cap enforcing anything.
 *
 * So the reported figure is a floor to rise to, never a ceiling to fall to.
 * Over-recording trips a cap early; under-recording lets a run exceed a cap it
 * believed it was under, on an account shared across the cohort.
 */
export function settlementUsd(reportedUsd: unknown, itemsCharged: number): number {
  const priced = config.limits.apifyActorStartUsd
    + Math.max(0, itemsCharged) * config.limits.apifyPricePerResultUsd;
  return typeof reportedUsd === 'number' && Number.isFinite(reportedUsd)
    ? Math.max(reportedUsd, priced)
    : priced;
}

/** Actors disagree on field names, so read the plausible ones and drop the row
 *  if none of them yields a domain. A candidate without a domain is not a
 *  candidate; it is a row that will waste a scrape. */
export function toCandidate(item: Record<string, unknown>): Candidate | null {
  // `linkedinUrl` is deliberately NOT in this list. A LinkedIn profile is not
  // a company website: normaliseDomain rejects it as an aggregator, and
  // researching one would breach the scope this build committed to.
  const raw = (item.website ?? item.url ?? item.domain ?? item.link ?? item.companyUrl) as
    string | undefined;
  if (typeof raw !== 'string') return null;
  const companyDomain = normaliseDomain(raw);
  if (!companyDomain) return null;

  const name = (item.name ?? item.title ?? item.companyName ?? item.company) as string | undefined;

  /**
   * Only the fields a qualification decision can use. The raw row carries
   * logos, background covers, follower counts and a similar-organisations
   * list, none of which says anything about fit, and all of which would sit
   * in the database on every candidate for ever.
   */
  const meta: Record<string, unknown> = {};
  for (const key of ['employeeCount', 'employeeCountRange', 'industries', 'industry',
                     'specialities', 'description', 'tagline', 'foundedOn', 'locations',
                     'location', 'linkedinUrl', 'pageVerified'] as const) {
    if (item[key] !== undefined && item[key] !== null) meta[key] = item[key];
  }

  return {
    companyName: (typeof name === 'string' && name.trim()) || companyDomain,
    companyDomain,
    meta,
  };
}

/**
 * A showcase page is a sub-brand, not a company.
 *
 * The smoke run of 2026-09-24 returned
 * `linkedin.com/showcase/advids-b2b-saas-enterprise-software-video-production-service`
 * as its top result. A showcase page belongs to a parent company and carries
 * the parent's website, but has its own name, follower count and headcount
 * range, so it arrives looking like a separate company. Keeping it either
 * duplicates the parent under a near-identical domain or spends a scrape on a
 * marketing sub-page that describes one product line.
 */
export function isShowcase(item: Record<string, unknown>): boolean {
  if (item.showcase === true) return true;
  const pageType = item.pageType;
  if (typeof pageType === 'string' && pageType.toUpperCase().includes('SHOWCASE')) return true;
  const url = item.linkedinUrl;
  return typeof url === 'string' && /\/showcase\//i.test(url);
}

export type HeadcountBounds = { min: number; max: number };

/** The bounds the ICP actually stated, as opposed to the buckets that have to
 *  be requested to cover them. */
export function parseHeadcount(range: string | undefined): HeadcountBounds | null {
  if (!range) return null;
  const numbers = String(range).match(/\d[\d,]*/g)?.map((n) => Number(n.replace(/,/g, '')));
  if (!numbers?.length || !Number.isFinite(numbers[0])) return null;
  return {
    min: numbers[0],
    max: numbers.length > 1 ? numbers[1] : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * The buckets widen the ICP, so the stated size is re-checked on the way back.
 *
 * "10 to 100" spans three LinkedIn buckets, so asking for `1-10` through
 * `51-200` is really asking for 1 to 200. Against exactly that ICP discovery
 * returned companies with an `employeeCountRange` of `{ start: 0, end: 1 }`.
 *
 * Only positive evidence disqualifies. A row with no size at all is kept,
 * because dropping on missing data loses real companies and the row has been
 * paid for either way; qualification judges it later against the scraped site.
 *
 * The range is preferred over `employeeCount`, which counts LinkedIn members
 * who list the company rather than staff, and which reads 0 for most small
 * companies. The range is the size the company states in its About tab, and is
 * what LinkedIn's own size filter matches on.
 */
export function withinHeadcount(
  meta: Record<string, unknown>, bounds: HeadcountBounds | null,
): boolean {
  if (!bounds) return true;

  const range = meta.employeeCountRange as { start?: unknown; end?: unknown } | undefined;
  if (range && typeof range === 'object') {
    const start = Number(range.start);
    const end = Number(range.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return end >= bounds.min && start <= bounds.max;
    }
  }

  const count = Number(meta.employeeCount);
  if (Number.isFinite(count) && count > 0) return count >= bounds.min && count <= bounds.max;

  return true;
}

/**
 * Aliases for the countries this ICP guide suggests. LinkedIn returns an ISO
 * code and a full name; an ICP is written by a person and says "US" or "the
 * United States" or "USA".
 */
const COUNTRY_ALIASES: Record<string, string> = {
  us: 'united states', usa: 'united states', 'u s a': 'united states',
  'united states of america': 'united states', america: 'united states',
  uk: 'united kingdom', gb: 'united kingdom', 'great britain': 'united kingdom',
  britain: 'united kingdom', england: 'united kingdom',
  ca: 'canada', au: 'australia', nz: 'new zealand', ie: 'ireland',
  de: 'germany', fr: 'france', nl: 'netherlands', es: 'spain', pt: 'portugal',
  sg: 'singapore', in: 'india', ae: 'united arab emirates', uae: 'united arab emirates',
  ng: 'nigeria', za: 'south africa', ke: 'kenya', gh: 'ghana',
  kr: 'south korea', jp: 'japan', br: 'brazil', mx: 'mexico',
};

const country = (value: unknown): string => {
  const raw = String(value ?? '').toLowerCase().replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return COUNTRY_ALIASES[raw] ?? raw;
};

/**
 * Where the company actually IS, checked against where the ICP wants it.
 *
 * LinkedIn's own location filter matches a company with AN office in the
 * target country, not one headquartered there. Asking for the United States
 * returned channel.io (Seoul) and demodesk.ai (Munich), both of which list a
 * US office, and both were then rejected by qualification at the cost of a
 * model call using the very field discovery had already paid for.
 *
 * The headquarters entry wins when there is one. As with headcount, only
 * positive evidence disqualifies: a row with no location is kept, because the
 * row is paid for either way and qualification can still judge it.
 */
export function withinGeography(
  meta: Record<string, unknown>, wanted: string[] | undefined,
): boolean {
  const targets = (wanted ?? []).map(country).filter(Boolean);
  if (!targets.length) return true;

  const locations = meta.locations as Array<Record<string, any>> | undefined;
  if (!Array.isArray(locations) || !locations.length) return true;

  const hq = locations.find((l) => l?.headquarter === true) ?? locations[0];
  const named = [hq?.parsed?.country, hq?.parsed?.countryCode, hq?.country]
    .map(country).filter(Boolean);
  if (!named.length) return true;

  return named.some((n) => targets.includes(n));
}

/**
 * LinkedIn's own headcount buckets. A range like "10 to 100" spans three of
 * them, and sending a bucket LinkedIn does not recognise returns nothing at
 * all rather than erroring, so anything unparseable yields no filter instead
 * of a guess.
 */
const SIZE_BUCKETS: Array<[string, number, number]> = [
  ['1-10', 1, 10],
  ['11-50', 11, 50],
  ['51-200', 51, 200],
  ['201-500', 201, 500],
  ['501-1000', 501, 1000],
  ['1001-5000', 1001, 5000],
  ['5001-10000', 5001, 10000],
  ['10001+', 10001, Number.MAX_SAFE_INTEGER],
];

export function headcountBuckets(range: string | undefined): string[] {
  const bounds = parseHeadcount(range);
  if (!bounds) return [];
  return SIZE_BUCKETS
    .filter(([, lo, hi]) => hi >= bounds.min && lo <= bounds.max)
    .map(([label]) => label);
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
  /**
   * Everything that was paid for and then thrown away, by reason.
   *
   * Dropping a row does not refund it. A run that returns ten rows and keeps
   * one is a fact the agent needs in order to widen its query, and a fact the
   * operator needs in order to explain where a budget went.
   */
  dropped: {
    showcase: number; noDomain: number; headcount: number;
    geography: number; duplicate: number;
  };
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
  opts: {
    client?: ApifyLike;
    wallClockMs?: number;
    filters?: DiscoveryFilters;
    /** Re-checked on the way back, because the LinkedIn buckets requested on
     *  the way out are wider than the range the ICP stated. */
    headcount?: HeadcountBounds | null;
    /** Re-checked on the way back, because LinkedIn's location filter matches
     *  a company with AN office in the country, not one headquartered there. */
    geography?: string[];
  } = {},
): Promise<Discovery> {
  const api: ApifyLike = opts.client ?? (apify() as unknown as ApifyLike);
  const wallClockMs = opts.wallClockMs ?? 200_000;
  const call = buildActorCall(queryText, limit, opts.filters ?? {});
  // The start fee is charged whatever the run returns, so it belongs in the
  // reservation. Leaving it out means a search that finds nothing reserves
  // nothing while still costing money, and several narrow searches in one run
  // each pay it.
  const estimate = settlementUsd(undefined, limit);
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
    // How many items it managed before dying is unknowable, so the run is
    // priced as though it did all the work it was allowed to do.
    await settle(
      settlementUsd(reported, limit),
      `actor=${actorId} runId=${started.id} did not complete, priced at the full reservation`,
    );
    throw e;
  }

  const reported = (finished as any).usageTotalUsd;
  const charged = settlementUsd(reported, items.length);
  await settle(
    charged,
    `actor=${actorId} runId=${finished.id} items=${items.length} ` +
    `reported=${typeof reported === 'number' ? reported : 'none'} settled=${charged}`,
  );

  const seen = new Set<string>();
  const out: Candidate[] = [];
  const dropped = { showcase: 0, noDomain: 0, headcount: 0, geography: 0, duplicate: 0 };

  for (const item of items as Record<string, unknown>[]) {
    // Order matters only for the counts: a row is reported under the first
    // reason it fails, so the numbers add up to the rows that were charged.
    if (isShowcase(item)) { dropped.showcase++; continue; }

    const c = toCandidate(item);
    if (!c) { dropped.noDomain++; continue; }

    if (!withinHeadcount(c.meta, opts.headcount ?? null)) { dropped.headcount++; continue; }

    if (!withinGeography(c.meta, opts.geography)) { dropped.geography++; continue; }

    if (seen.has(c.companyDomain)) { dropped.duplicate++; continue; }
    seen.add(c.companyDomain);
    out.push(c);
  }

  return { candidates: out, itemsCharged: items.length, dropped };
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
