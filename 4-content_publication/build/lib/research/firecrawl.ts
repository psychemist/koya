import { config } from '../config';
import { sha256 } from '../hash';
import { AppError } from '../errors';
import type { FetchedSource } from './types';
import { profileSections, boilerplateRatio } from './parse';

const BASE = 'https://api.firecrawl.dev';

/**
 * Firecrawl is primary because we must OWN the bytes.
 *
 * A claim has to be checkable against text we hold, not against a search
 * summary that no longer exists by the time an approver reads the draft.
 * Claude's native web_search is cheaper and simpler, and it cannot do that.
 *
 * Two parameters here are doing real work:
 *   onlyMainContent — deterministic nav/header/footer strip, so we are not
 *                     paying a model to read someone's cookie banner.
 *   maxAge          — 48h index hit. Two managers researching the same topic
 *                     in the same week do not pay to fetch the page twice.
 *                     This is "reuse results instead of recomputing them",
 *                     implemented by a vendor parameter rather than by us.
 */
export async function firecrawlScrape(url: string, opts: { maxPdfPages?: number } = {}): Promise<FetchedSource> {
  if (!config.firecrawlKey) {
    throw new AppError('firecrawl_not_configured', 'Firecrawl is not configured.', 503, undefined, false);
  }

  const res = await fetch(`${BASE}/v2/scrape`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.firecrawlKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url,
      onlyMainContent: true,
      formats: ['markdown', 'links'],
      maxAge: 172_800_000,
      parsers: [{ type: 'pdf', maxPages: opts.maxPdfPages ?? 20 }],
      redactPII: true,
      blockAds: true,
      timeout: 30_000,
    }),
  });

  // 402 and 429 are DIFFERENT failures and must not share a code. Falling back
  // on a 402 is correct; retrying a 402 is a loop that never terminates.
  if (res.status === 402) {
    throw new AppError('firecrawl_credits_exhausted',
      'Firecrawl credits are exhausted.', 502, undefined, false);
  }
  if (res.status === 429) {
    throw new AppError('firecrawl_rate_limited',
      'Firecrawl is rate limiting us.', 502, undefined, true);
  }
  if (!res.ok) {
    throw new AppError('firecrawl_error',
      `Firecrawl returned ${res.status}.`, 502, undefined, res.status >= 500);
  }

  const json = await res.json() as any;
  const data = json?.data ?? {};
  const md: string = data.markdown ?? '';
  const meta = data.metadata ?? {};

  return classify({
    submittedUrl: url,
    finalUrl: meta.url ?? meta.sourceURL ?? url,
    provider: 'firecrawl',
    httpStatus: typeof meta.statusCode === 'number' ? meta.statusCode : res.status,
    markdown: md,
    contentHash: sha256(md),
    title: firstOf(meta.title),
    language: firstOf(meta.language),
    publishedAt: firstOf(meta.publishedTime ?? meta.publishedAt),
    sectionProfile: profileSections(md),
    status: 'ok',
  });
}

export async function firecrawlSearch(q: string, limit = 6): Promise<{ url: string; title?: string }[]> {
  if (!config.firecrawlKey) return [];
  const res = await fetch(`${BASE}/v2/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.firecrawlKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, limit }),
  });
  if (!res.ok) return [];
  const json = await res.json() as any;
  const items = json?.data?.web ?? json?.data ?? [];
  return (Array.isArray(items) ? items : [])
    .map((i: any) => ({ url: i.url, title: i.title }))
    .filter((i: any) => typeof i.url === 'string');
}

/**
 * A page that came back 200 with nothing usable in it is not a source.
 *
 * This is the Week 1 lesson in a new costume: a PDF with no text layer is a
 * scan, not a document, and passing an empty string to a model is how you get
 * a confident article about nothing.
 */
export function classify(s: FetchedSource): FetchedSource {
  const md = s.markdown ?? '';
  const words = md.split(/\s+/).filter(Boolean).length;

  if ((s.httpStatus ?? 0) === 402 || /subscribe to (read|continue)|this article is for subscribers/i.test(md)) {
    return { ...s, status: 'paywalled', failureReason: 'The page is behind a paywall.' };
  }
  if (words < 150) {
    return {
      ...s, status: 'boilerplate',
      failureReason: `Only ${words} words of main content were returned, which is not enough to source from.`,
    };
  }
  if (boilerplateRatio(md) > 0.6) {
    return { ...s, status: 'boilerplate', failureReason: 'The page returned mostly navigation and chrome.' };
  }
  return s;
}

const firstOf = (v: unknown): string | undefined =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined)
  : typeof v === 'string' ? v : undefined;
