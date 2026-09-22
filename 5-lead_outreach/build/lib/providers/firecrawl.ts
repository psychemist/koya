import { config } from '../config.ts';
import { ProviderError } from '../errors.ts';
import { sha256 } from '../hash.ts';
import { query, one } from '../db.ts';

export type Fetched = { markdown: string; statusCode: number };
export type Fetcher = (url: string) => Promise<Fetched>;

export type ScrapeResult = {
  markdown: string;
  httpStatus: number;
  contentHash: string;
  usable: boolean;
  fromCache: boolean;
  provider: 'firecrawl' | 'cache';
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
 * Do not pay to read a page twice.
 *
 * The cache is global rather than per run, because the same company turns up
 * in two runs a week apart and the second one should cost nothing.
 */
export async function scrape(
  url: string, opts: { fetcher?: Fetcher } = {},
): Promise<ScrapeResult> {
  const urlNorm = normaliseUrl(url);

  const cached = await one<{ markdown: string; content_hash: string; http_status: number }>(
    'select markdown, content_hash, http_status from public.scrape_cache where url_norm = $1',
    [urlNorm],
  );
  if (cached) {
    return {
      markdown: cached.markdown,
      httpStatus: cached.http_status ?? 200,
      contentHash: cached.content_hash,
      usable: isUsable(cached.markdown),
      fromCache: true,
      provider: 'cache',
    };
  }

  const fetcher = opts.fetcher ?? firecrawlFetcher;
  const host = new URL(urlNorm).hostname;

  let fetched: Fetched;
  try {
    fetched = await withDomainSlot(host, () => fetcher(urlNorm));
  } catch (e) {
    throw mapError(e);
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
    provider: 'firecrawl',
  };
}
