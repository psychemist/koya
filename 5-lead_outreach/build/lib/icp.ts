import { sha256 } from './hash.ts';

/**
 * A stable key for "the same targeting criteria".
 *
 * A verdict is a function of (company facts, ICP), so a stored verdict is only
 * reusable against the same ICP: "not qualified" under one says nothing under
 * another, and reusing one across a merely similar ICP is how a wrong
 * rejection gets inherited without anyone seeing it happen.
 *
 * This exists first to MEASURE, not to reuse. Every run today throws away
 * every judgement it made, and whether a cross-run cache is worth building
 * depends on how much two runs actually overlap, which one run cannot answer.
 * Recording the fingerprint alongside each verdict makes that measurable
 * without changing a single decision.
 *
 * Only the fields that decide a verdict are folded in. Persona and business
 * problem shape the outreach copy, not who qualifies, and including them would
 * make two identically judged runs look unrelated.
 */
const DECIDING_FIELDS = [
  'industries', 'geography', 'headcount_range', 'hard_filters', 'disqualifiers',
] as const;

/** Lowercased, space-collapsed, so "  United States " and "united states" are
 *  the same criterion rather than two. */
function normalise(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Sorted, because an ICP naming two industries means the same thing in either
 *  order. Unsorted, no run would ever match another. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalise).sort().join('|');
  return normalise(value);
}

export function icpFingerprint(icp: unknown): string {
  const source = (icp && typeof icp === 'object' ? icp : {}) as Record<string, unknown>;
  const material = DECIDING_FIELDS
    .map((field) => `${field}=${canonical(source[field])}`)
    .join('\n');
  return sha256(material);
}
