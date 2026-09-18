/**
 * Turns a stored draft into the HTML the proof renders, with three things
 * marked: unsupported claims, citation markers, and unfilled source gaps.
 *
 * WHY THE MARKERS NEEDED MARKING.
 *
 * `[S1d20P1]` is an excerpt label: a source row's uuid prefix and an ordinal.
 * The drafting contract requires one beside every figure, and the grounding
 * check depends on them. Rendered as plain text in the middle of a serif
 * paragraph they read as part of the sentence, which is how a reviewer stops
 * seeing them and then cannot say whether they were supposed to be there.
 * Worse, two people reading this screen took them for corrupted text.
 *
 * So they are set apart: mono, smaller, tinted, and carrying a title that says
 * what they are and that they come off before publishing. The point is that a
 * reader can tell at a glance this is apparatus, not prose.
 *
 * MARKING IS DONE BY COMPUTING CHARACTER RANGES AND SPLICING THEM IN ONCE,
 * rather than running a replace per claim. Two claims that overlap, or one
 * that contains another, used to produce a <mark> inside a <mark>: the
 * original guarded that with a variable-length regex lookbehind built from the
 * claim text itself. Merged, non-overlapping ranges make nesting impossible by
 * construction, and no claim text is ever compiled into a pattern.
 */
export const CITATION_RE = /\[\s*S[0-9a-f]{1,8}P\d{1,4}(?:\s*[,;]\s*S[0-9a-f]{1,8}P\d{1,4})*\s*\]/gi;
export const NEEDS_SOURCE_RE = /\[NEEDS SOURCE:[^\]]*\]/gi;

export const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

/** A single label out of a marker, which can carry several: `S1d20P1`. */
const LABEL_RE = /S[0-9a-f]{1,8}P\d{1,4}/gi;

type Range = { start: number; end: number; kind: 'unsupported' | 'cite' | 'gap' };

export function markBody(
  escaped: string,
  unsupportedClaims: string[],
  /**
   * label -> what to show for it, e.g. "Title (https://example.com/post)".
   * Keyed by the bare label (`S1d20P1`), which `excerpts.label` already
   * stores next to the source it came from — this just carries that mapping
   * through to the tooltip instead of a sentence that names no source.
   */
  citations: Record<string, string> = {},
): string {
  const ranges: Range[] = [];

  // Unsupported claims first: they are the finding, and where a citation
  // marker sits inside one, being struck matters more than being labelled.
  for (const raw of unsupportedClaims) {
    const c = esc(raw);
    if (c.length < 3) continue;
    for (let from = 0; ;) {
      const at = escaped.indexOf(c, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + c.length, kind: 'unsupported' });
      from = at + c.length;
    }
  }

  // Merge the claim ranges among themselves, so one claim containing another
  // produces a single span rather than a nested pair.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  const overlapsClaim = (start: number, end: number) =>
    merged.some((m) => start < m.end && end > m.start);

  for (const [re, kind] of [[CITATION_RE, 'cite'], [NEEDS_SOURCE_RE, 'gap']] as const) {
    re.lastIndex = 0;
    for (const m of escaped.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Dropped rather than nested. A citation inside a struck claim is
      // already visible as part of the strike.
      if (overlapsClaim(start, end)) continue;
      merged.push({ start, end, kind });
    }
  }

  if (!merged.length) return escaped;
  merged.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const r of merged) {
    if (r.start < cursor) continue; // belt and braces against any residual overlap
    out += escaped.slice(cursor, r.start) + wrap(r.kind, escaped.slice(r.start, r.end), citations);
    cursor = r.end;
  }
  return out + escaped.slice(cursor);
}

function wrap(kind: Range['kind'], text: string, citations: Record<string, string>): string {
  if (kind === 'unsupported') {
    return `<mark class="unsupported" title="No source excerpt supports this">${text}</mark>`;
  }
  if (kind === 'gap') {
    return `<span class="gap" title="The draft is asking for a source it does not have. ` +
      `This blocks approval: find the fact in a source, or cut the sentence.">${text}</span>`;
  }

  // One or more labels inside a single marker (`[S1d20P1, S2f3eP2]`). Each
  // resolves independently, so the tooltip names every source a combined
  // marker points at rather than only the first.
  const labels = [...text.matchAll(LABEL_RE)].map((m) => m[0]);
  const resolved = labels.map((l) => citations[l] ? `${l} → ${citations[l]}` : null).filter(Boolean);
  const title = resolved.length
    ? resolved.join('\n')
    : 'Citation marker. It points at the source excerpt this figure came from, and it is ' +
      'removed before the post is published.';
  return `<span class="cite" title="${escAttr(title)}">${text}</span>`;
}
