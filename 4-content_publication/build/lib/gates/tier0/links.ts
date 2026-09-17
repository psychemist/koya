import { flag, type Flag, type AssetKind } from '../types';

/**
 * Two checks a regex can do that a model cannot be trusted to do for itself.
 *
 * 1. Every URL in the draft was in the source set. An invented URL is a
 *    classic hallucination, it is free to catch, and it is the one a reader
 *    clicks on.
 * 2. Every URL resolves. A 404 in a published article is indistinguishable
 *    from carelessness, which is exactly what the system exists to prevent.
 *
 * Internal-link candidates are held to a similarity threshold elsewhere:
 * Yoast is explicit that a random internal link DAMAGES relevance signals, so
 * a weak match is worse than no link at all.
 */
export function extractUrls(text: string): { url: string; anchor: string; start: number }[] {
  const out: { url: string; anchor: string; start: number }[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    out.push({ anchor: m[1], url: m[2], start: m.index ?? 0 });
  }
  for (const m of text.matchAll(/(?<!\]\()\bhttps?:\/\/[^\s)<>\]]+/g)) {
    if (!out.some((o) => o.url === m[0])) out.push({ anchor: '', url: m[0], start: m.index ?? 0 });
  }
  return out;
}

const BAD_ANCHOR = /^(click here|here|this|read more|link|this article)$/i;

export function checkLinksInSourceSet(
  draft: string, allowed: string[], assetKind: AssetKind,
): Flag[] {
  const flags: Flag[] = [];
  const allowedHosts = new Set(allowed.map(hostOf).filter(Boolean));
  const allowedExact = new Set(allowed.map(norm));

  for (const { url, anchor, start } of extractUrls(draft)) {
    if (!allowedExact.has(norm(url)) && !allowedHosts.has(hostOf(url))) {
      flags.push(flag('link_not_in_source_set', assetKind, 'blocking',
        `${url} was not in the source set for this request.`,
        `Remove ${url}. Only link to URLs that appear in the supplied source list. ` +
        `a URL you constructed is a hallucination even when the page happens to exist.`,
        [start, start + url.length]));
    }
    if (anchor && BAD_ANCHOR.test(anchor.trim())) {
      flags.push(flag('link_weak_anchor', assetKind, 'advisory',
        `Anchor text "${anchor}" does not describe the destination.`,
        `Replace "${anchor}" with anchor text that says what the reader will find there.`,
        [start, start + anchor.length]));
    }
  }
  return flags;
}

/** Network check. Kept separate so unit tests can run the cheap half offline. */
export async function checkLinksResolve(
  draft: string, assetKind: AssetKind, timeoutMs = 6000,
): Promise<Flag[]> {
  const urls = [...new Set(extractUrls(draft).map((u) => u.url))];
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
      // Plenty of sites refuse HEAD but serve GET. Treating a 405 as a dead
      // link would flag perfectly good references.
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      }
      clearTimeout(t);
      return res.ok || res.status === 403 ? null : { url, status: res.status };
    } catch {
      return { url, status: 0 };
    }
  }));

  return results.filter(Boolean).map((r) => flag(
    'link_unreachable', assetKind, 'advisory',
    r!.status ? `${r!.url} returned ${r!.status}.` : `${r!.url} could not be reached.`,
    `Replace ${r!.url} with a working URL from the source list, or remove the link.`,
  ));
}

const norm = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
const hostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
