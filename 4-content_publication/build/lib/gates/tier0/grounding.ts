import { flag, type Flag, type AssetKind } from '../types';

/**
 * The mechanical half of source grounding, at zero token cost.
 *
 * Every figure, percentage, currency amount, date, quoted string and proper
 * noun in the draft must appear in a SELECTED excerpt. This is the check that
 * catches the expensive failure — the invented statistic — before anyone pays
 * a model to have an opinion about it.
 *
 * It is deliberately mechanical and deliberately narrow. Semantic claims
 * ("we have worked with three firms in your sector") are Tier 1's job; a
 * regex cannot evaluate them. What a regex CAN do is prove a number came
 * from somewhere, and that is the claim most likely to end up in a screenshot.
 */
export type Candidate = { text: string; kind: string; start: number; end: number };

const PATTERNS: [string, RegExp][] = [
  ['currency', /(?:[$£€]\s?\d[\d,.]*\s?(?:k|m|bn|billion|million|thousand)?)/gi],
  ['percent',  /\d+(?:\.\d+)?\s?%/g],
  ['year',     /\b(?:19|20)\d{2}\b/g],
  ['number',   /\b\d[\d,]*(?:\.\d+)?\b/g],
  ['quote',    /[""]([^""]{12,})[""]|"([^"]{12,})"/g],
];

export function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? m[0]).trim();
      if (!raw) continue;
      const key = `${kind}:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: raw, kind, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  // Proper nouns: capitalised runs that are not sentence-initial. Noisy by
  // nature, so they are ADVISORY — a false positive here must not block a
  // publish, or the gate trains people to waive things.
  //
  // HEADINGS ARE MASKED OUT FIRST, and that is not a tidiness fix. House
  // style sets headings in Title Case, so every heading is a run of
  // capitalised words, and the checker read each one as an unverifiable
  // proper noun. The first real article produced eight unsupported claims, of
  // which seven were fragments of its own headings: "Gate One", "The Two
  // Gates Where", "Normal Engineering Loop". The one that mattered, an
  // invented turnaround figure, was buried among them.
  //
  // That is the precise failure this gate exists to prevent. A reviewer who
  // is shown seven false positives learns to skim the list, and the eighth
  // item is the one that ends up on a client's feed. Masking preserves offsets
  // by replacing the heading with spaces, so every span stays correct.
  const bodyOnly = text.replace(/^#{1,6}[^\n]*/gm, (h) => ' '.repeat(h.length));

  for (const m of bodyOnly.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b/gm)) {
    const raw = m[1];
    if (STOPWORDS.has(raw)) continue;
    const key = `proper_noun:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: raw, kind: 'proper_noun', start: m.index ?? 0, end: (m.index ?? 0) + raw.length });
  }
  return out;
}

export function checkGrounding(
  draft: string, excerpts: { label: string; text: string }[], assetKind: AssetKind,
): { flags: Flag[]; claims: { text: string; status: 'supported' | 'unsupported'; label?: string }[] } {
  const haystack = excerpts.map((e) => normalise(e.text)).join('\n');
  const byLabel = excerpts.map((e) => ({ label: e.label, norm: normalise(e.text) }));
  const flags: Flag[] = [];
  const claims: { text: string; status: 'supported' | 'unsupported'; label?: string }[] = [];

  for (const c of extractCandidates(draft)) {
    // Small integers are ordinals and list counts, not claims. Checking them
    // produces noise that drowns the ones that matter.
    if (c.kind === 'number' && Number(c.text.replace(/,/g, '')) <= 10) continue;

    const needle = normalise(c.text);
    const hit = byLabel.find((e) => e.norm.includes(needle));
    if (hit) {
      claims.push({ text: c.text, status: 'supported', label: hit.label });
      continue;
    }
    claims.push({ text: c.text, status: 'unsupported' });

    const severity = c.kind === 'proper_noun' ? 'advisory' : 'blocking';
    flags.push(flag(
      `grounding_unsupported_${c.kind}`, assetKind, severity,
      `"${c.text}" does not appear in any selected source excerpt.`,
      `Remove "${c.text}", or replace it with a figure that appears in an excerpt and ` +
      `cite that excerpt. If the sources do not carry this fact, say so plainly rather ` +
      `than supplying a plausible one. A marked gap is the correct answer.`,
      [c.start, c.end],
    ));
    void haystack;
  }
  return { flags, claims };
}

const normalise = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
   .replace(/\s+/g, ' ').replace(/[,](?=\d{3}\b)/g, '').trim();

const STOPWORDS = new Set([
  'The Company', 'This Article', 'In This', 'For Example', 'That Said',
]);
