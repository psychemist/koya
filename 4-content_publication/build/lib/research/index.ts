import { firecrawlScrape, firecrawlSearch } from './firecrawl';
import { claudeWebFetch } from './webfetch';
import { robotsAllows } from './robots';
import { screen } from './injection';
import { deriveSectionBand } from './parse';
import { sha256 } from '../hash';
import type { FetchedSource } from './types';

export * from './types';
export { deriveSectionBand, profileSections } from './parse';
export { screen } from './injection';
export { firecrawlSearch } from './firecrawl';

export type ScreenedSource = FetchedSource & {
  injectionFlags: { code: string; evidence: string }[];
  quarantined: boolean;
};

/**
 * Fetch one URL, through the fallback chain, and screen what comes back.
 *
 * Order is by cost and by control:
 *   1. Firecrawl   — we own the bytes, hashable and re-readable at review time
 *   2. web_fetch   — free beyond tokens, so an outage DEGRADES rather than stops
 *   3. manual      — the human pastes it (handled by the caller, not here)
 *
 * Every outcome is a row with a visible status. Nothing is ever dropped
 * quietly: the reviewer must be able to tell "we chose not to use this" from
 * "we could not fetch this".
 */
export async function fetchAndScreen(url: string): Promise<ScreenedSource> {
  const base = { submittedUrl: url, contentHash: sha256(url), sectionProfile: [] as never[] };

  if (!(await robotsAllows(url))) {
    return {
      ...base, provider: 'firecrawl', status: 'robots_denied',
      failureReason: "The site's robots.txt disallows fetching this path.",
      injectionFlags: [], quarantined: false,
    };
  }

  let fetched: FetchedSource | null = null;
  let firstError: string | undefined;

  try {
    fetched = await firecrawlScrape(url);
  } catch (e) {
    firstError = e instanceof Error ? e.message : String(e);
    try {
      fetched = await claudeWebFetch(url);
    } catch (e2) {
      return {
        ...base, provider: 'firecrawl', status: 'failed',
        failureReason: `Firecrawl: ${firstError}. Fallback fetch also failed: ` +
          `${e2 instanceof Error ? e2.message : String(e2)}`,
        injectionFlags: [], quarantined: false,
      };
    }
  }

  if (fetched.status !== 'ok') {
    return { ...fetched, injectionFlags: [], quarantined: false };
  }

  const { cleaned, findings, quarantine } = screen(fetched.markdown ?? '');
  return {
    ...fetched,
    markdown: cleaned,
    contentHash: sha256(cleaned),
    injectionFlags: findings,
    quarantined: quarantine,
  };
}

/**
 * Discovery. Runs even when the manager supplied their own URLs, for two
 * reasons that both come from the source documents rather than from us:
 *
 *   - the SEO doc's "analyze top-performing articles" step needs COMPETING
 *     articles to pull long-tail keywords from, not just the page the manager
 *     happened to read;
 *   - decision B-5 derives the per-section word band from what those
 *     competitors actually do, and three of them is the minimum that counts
 *     as a measurement rather than an anecdote.
 */
export async function discover(idea: string, keywordHint?: string): Promise<string[]> {
  const q = keywordHint?.trim() ? `${keywordHint} ${idea}` : idea;
  const hits = await firecrawlSearch(q, 8);
  return hits.map((h) => h.url);
}
