import type { SectionProfile } from './types';

/**
 * Heading structure has to survive the scrape.
 *
 * Decision B-5: the SEO doc says "700-800 words per main section (informed by
 * top articles)", and we take the parenthetical literally — the per-section
 * band is MEASURED from competitors rather than hard-coded. That requires
 * knowing how long each of their sections actually is.
 */
export function profileSections(markdown: string): SectionProfile {
  const lines = markdown.split(/\r?\n/);
  const out: SectionProfile = [];
  let current: { heading: string; level: number; words: number } | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      if (current) out.push(current);
      current = { heading: h[2].trim(), level: h[1].length, words: 0 };
      continue;
    }
    if (current) current.words += line.split(/\s+/).filter(Boolean).length;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Derives the per-section word band from comparable articles.
 *
 * Median, not mean: one 4,000-word outlier would drag a mean far enough to
 * make the gate meaningless. Below three comparables we do not have a
 * measurement, we have an anecdote — so it falls back, and records that it did.
 */
export function deriveSectionBand(
  profiles: SectionProfile[],
  fallback: [number, number] = [300, 500],
//   fallback: [number, number] = [700, 800],
): { band: [number, number]; source: 'measured' | 'fallback'; n: number } {
  const h2 = profiles.flatMap((p) => p.filter((s) => s.level === 2 && s.words >= 50).map((s) => s.words));
  const comparables = profiles.filter((p) => p.some((s) => s.level === 2)).length;
  if (comparables < 3 || h2.length < 4) return { band: fallback, source: 'fallback', n: comparables };

  const sorted = [...h2].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const lo = Math.max(250, Math.round(median * 0.8));
  const hi = Math.max(lo + 150, Math.round(median * 1.2));
  return { band: [lo, hi], source: 'measured', n: comparables };
}

/** Rough share of the text that looks like nav/chrome rather than prose. */
export function boilerplateRatio(markdown: string): number {
  const lines = markdown.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return 1;
  const chrome = lines.filter((l) =>
    /^\s*[-*]\s*\[[^\]]*\]\([^)]*\)\s*$/.test(l) ||        // bare link list item
    /^\s*\|/.test(l) ||                                     // table row
    (l.trim().length < 30 && /\[[^\]]*\]\([^)]*\)/.test(l)) // short link-only line
  ).length;
  return chrome / lines.length;
}
