import { flag, type Flag, type AssetKind } from '../types';

/**
 * The check nobody builds.
 *
 * "Grounded" must not slide into "copied". A draft that reproduces a long run
 * of a source verbatim is a copyright exposure, not a quality nit — and every
 * other gate in this system actively pushes the model TOWARD the source text,
 * so the risk is created by the design rather than in spite of it.
 *
 * Longest common word-run, per source. Quoted material is exempt up to a
 * limit: quoting IS allowed, lifting is not, and the difference is whether
 * the reader can see it is a quote.
 */
export const MAX_VERBATIM_WORDS = 25;
export const MAX_QUOTED_WORDS = 40;

export function longestCommonRun(a: string, b: string): { words: number; text: string } {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return { words: 0, text: '' };

  // Rolling single-row DP: the full matrix for two long articles is hundreds
  // of megabytes, and this runs on every draft.
  let prev = new Uint32Array(y.length + 1);
  let best = 0, bestEndX = 0;
  for (let i = 1; i <= x.length; i++) {
    const cur = new Uint32Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; bestEndX = i; }
      }
    }
    prev = cur;
  }
  return { words: best, text: x.slice(bestEndX - best, bestEndX).join(' ') };
}

export function checkVerbatim(
  draft: string, sources: { label: string; text: string }[], assetKind: AssetKind,
): Flag[] {
  const flags: Flag[] = [];
  for (const s of sources) {
    const { words: n, text } = longestCommonRun(draft, s.text);
    if (n <= MAX_VERBATIM_WORDS) continue;

    const quoted = isQuoted(draft, text);
    if (quoted && n <= MAX_QUOTED_WORDS) continue;

    flags.push(flag(
      quoted ? 'verbatim_quote_too_long' : 'verbatim_lift', assetKind,
      'blocking',
      `${n} consecutive words match source ${s.label}` +
      (quoted ? ' inside a quotation.' : ' without being marked as a quote.'),
      quoted
        ? `Shorten the quotation from ${s.label} to under ${MAX_QUOTED_WORDS} words and paraphrase the rest.`
        : `Rewrite this passage in your own words and cite ${s.label}, or mark it explicitly ` +
          `as a quotation and keep it under ${MAX_QUOTED_WORDS} words. Reproducing ${n} ` +
          `consecutive words unmarked is copying, not grounding.`,
    ));
  }
  return flags;
}

const words = (s: string) =>
  s.toLowerCase().replace(/\[S\d+P\d+\]/g, ' ').replace(/[^a-z0-9\s]/g, ' ')
   .split(/\s+/).filter(Boolean);

function isQuoted(draft: string, run: string): boolean {
  const head = run.split(' ').slice(0, 4).join(' ');
  const i = draft.toLowerCase().indexOf(head);
  if (i < 0) return false;
  const before = draft.slice(Math.max(0, i - 3), i);
  return /["“”'>]/.test(before);
}
