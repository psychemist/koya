import { config } from '../config.ts';
import { ProviderError } from '../errors.ts';
import { sha256 } from '../hash.ts';
import { query, one } from '../db.ts';

export type Fetched = { markdown: string; statusCode: number };
export type Fetcher = (url: string) => Promise<Fetched>;

export type ScrapeProvider = 'firecrawl' | 'direct' | 'cache';

export type ScrapeResult = {
  markdown: string;
  httpStatus: number;
  contentHash: string;
  usable: boolean;
  fromCache: boolean;
  provider: ScrapeProvider;
  /**
   * When the page was FETCHED, which for a cache hit is not now.
   *
   * The caller stamps this into the evidence envelope the qualification model
   * reads. Stamping the serving time instead tells the model a weeks-old page
   * was read this second, which is a false citation in the one place this
   * build promises sourced evidence.
   */
  retrievedAt: Date;
};

/**
 * The cache key.
 *
 * Two spellings of one page must collapse to one key or the cache never hits
 * and every run pays again. Tracking parameters are dropped because they
 * change per referral and describe the link, not the page.
 */
const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|source$)/i;

export function normaliseUrl(input: string): string {
  const u = new URL(input.includes('://') ? input : `https://${input}`);
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = 'https:';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key);
  }
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString().replace(/\/$/, '');
}

/**
 * A page that is nav, footer and nothing else is not evidence. Passing an
 * empty shell to the model is how a company gets qualified on the strength of
 * the word "Home".
 */
const BOILERPLATE = /^(home|about|contact|products?|pricing|login|sign ?up|blog|careers|menu)$/i;

export function isUsable(markdown: string): boolean {
  const words = markdown
    .replace(/[#*_>`\[\]()|-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !BOILERPLATE.test(w));
  return words.length >= 200;
}

/** One slot per two requests to the same host. A small company's site should
 *  not notice us at all. */
const inFlight = new Map<string, number>();
const PER_DOMAIN_LIMIT = 2;

async function withDomainSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  while ((inFlight.get(host) ?? 0) >= PER_DOMAIN_LIMIT) {
    await new Promise((r) => setTimeout(r, 120));
  }
  inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (inFlight.get(host) ?? 1) - 1;
    if (n <= 0) inFlight.delete(host); else inFlight.set(host, n);
  }
}

const firecrawlFetcher: Fetcher = async (url) => {
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.firecrawlKey()}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,      // strips nav and footer chrome before we see it
      timeout: 30_000,
      maxAge: 172_800_000,        // a 48 hour index hit costs nothing
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const err = new Error(`Firecrawl responded ${res.status}`) as Error & { statusCode: number };
    err.statusCode = res.status;
    throw err;
  }

  const body = await res.json() as {
    data?: { markdown?: string; metadata?: { statusCode?: number } };
  };
  return {
    markdown: body.data?.markdown ?? '',
    statusCode: body.data?.metadata?.statusCode ?? res.status,
  };
};

/**
 * The secondary lane, used when Firecrawl is out of credits or rate limiting.
 *
 * Deliberately crude: fetch the page and strip it to text. It gets less than
 * Firecrawl does and will fail on anything that needs JavaScript, which is
 * why it is second. The alternative is that a spent credit balance ends the
 * research entirely, and a thinner page is worth more than no page.
 *
 * Which provider served each page is recorded, so a reviewer can see that a
 * lead was judged from the weaker source.
 */
const directFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'KoyaLeadDesk/1.0 (+company research; contact via koya.test)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = new Error(`Direct fetch responded ${res.status}`) as Error & { statusCode: number };
    err.statusCode = res.status;
    throw err;
  }
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return { markdown: text, statusCode: res.status };
};

/** Firecrawl failures that mean "this provider cannot serve this page right
 *  now", as opposed to "this page does not exist". Only the former falls back:
 *  a dead domain is dead on both lanes. */
const FALLBACK_WORTHY = new Set(['FIRECRAWL_402', 'FIRECRAWL_429', 'FIRECRAWL_5XX']);

function mapError(e: any): ProviderError {
  const status = e?.statusCode ?? e?.status;
  if (status === 402) {
    return new ProviderError('FIRECRAWL_402',
      'Firecrawl credits are exhausted. No further pages can be fetched this run.');
  }
  if (status === 429) {
    return new ProviderError('FIRECRAWL_429', 'Firecrawl rate limited this request.', true);
  }
  if (status === 403) {
    return new ProviderError('SCRAPE_403',
      'The site refused the request. Treat this company as unresearched, not as unqualified.');
  }
  if (status === 404 || e?.code === 'ENOTFOUND') {
    return new ProviderError('SCRAPE_DEAD', 'The page does not exist.');
  }
  if (typeof status === 'number' && status >= 500) {
    return new ProviderError('FIRECRAWL_5XX', `Firecrawl responded ${status}.`, true);
  }
  return new ProviderError('SCRAPE_FAILED', `Scrape failed: ${e?.message ?? e}`);
}

/**
 * Do not pay to read a page twice, and do not read a stale page at all.
 *
 * The cache is global rather than per run, because the same company turns up
 * in two runs a week apart and the second one should not pay Firecrawl again.
 * It is bounded by `SCRAPE_CACHE_MAX_AGE_DAYS`, because a company's website is
 * exactly the thing that changes, and `fetched_at` was previously written on
 * every insert and read by nobody.
 *
 * Note that a cache hit is free of FIRECRAWL cost, not free: the caller still
 * runs the injection screen over the text, which is a model call.
 */
export async function scrape(
  url: string, opts: { fetcher?: Fetcher } = {},
): Promise<ScrapeResult> {
  const urlNorm = normaliseUrl(url);

  const cached = await one<{
    markdown: string; content_hash: string; http_status: number; fetched_at: Date;
  }>(
    `select markdown, content_hash, http_status, fetched_at
       from public.scrape_cache
      where url_norm = $1
        and fetched_at > now() - ($2 || ' days')::interval`,
    [urlNorm, String(config.limits.scrapeCacheMaxAgeDays)],
  );
  if (cached) {
    return {
      markdown: cached.markdown,
      httpStatus: cached.http_status ?? 200,
      contentHash: cached.content_hash,
      usable: isUsable(cached.markdown),
      fromCache: true,
      provider: 'cache',
      retrievedAt: new Date(cached.fetched_at),
    };
  }

  const fetcher = opts.fetcher ?? firecrawlFetcher;
  const host = new URL(urlNorm).hostname;

  let fetched: Fetched;
  let provider: ScrapeProvider = 'firecrawl';
  try {
    fetched = await withDomainSlot(host, () => fetcher(urlNorm));
  } catch (e) {
    const mapped = mapError(e);
    // A stubbed fetcher is the test's whole point, so it is never silently
    // replaced by a real network call.
    if (opts.fetcher || !FALLBACK_WORTHY.has(mapped.code)) throw mapped;
    try {
      fetched = await withDomainSlot(host, () => directFetcher(urlNorm));
      provider = 'direct';
    } catch {
      throw mapped;     // report the primary failure, not the secondary one
    }
  }

  const contentHash = sha256(fetched.markdown);
  await query(
    `insert into public.scrape_cache (url_norm, content_hash, markdown, http_status)
     values ($1,$2,$3,$4)
     on conflict (url_norm) do update
       set content_hash = excluded.content_hash,
           markdown     = excluded.markdown,
           http_status  = excluded.http_status,
           fetched_at   = now()`,
    [urlNorm, contentHash, fetched.markdown, fetched.statusCode],
  );

  return {
    markdown: fetched.markdown,
    httpStatus: fetched.statusCode,
    contentHash,
    usable: isUsable(fetched.markdown),
    fromCache: false,
    provider,
    retrievedAt: new Date(),
  };
}
