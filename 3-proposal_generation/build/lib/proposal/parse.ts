import { GAP_CLOSE, GAP_OPEN, SECTION_CLOSE, SECTION_OPEN } from "../claude/prompts";
import { isSectionKey, type SectionKey } from "./sections";
import { gapFingerprint, type GapCandidate } from "./intake";

/**
 * Parsing the model's output.
 *
 * Everything in this file is pure: strings in, structures out, no database and
 * no network. That is what lets the whole of it be tested exhaustively for
 * free, which matters because this is the layer where a malformed response
 * turns into either a clean error or a corrupted proposal.
 */

/** The largest k < marker.length such that buf ends with marker.slice(0, k). */
function partialSuffixLength(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (buf.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

export type SectionDelta = { key: SectionKey; delta: string };

/**
 * Incremental parser for the streamed draft.
 *
 * The model emits `<<<SECTION:pricing>>>` markers between sections, and the
 * network hands us those markers split at arbitrary byte boundaries — a chunk
 * can end mid-marker, or even mid-`>>>`. Naively searching each chunk would
 * leak marker fragments into the rendered proposal, which is the kind of bug
 * that only shows up on a slow connection during a demo.
 *
 * The fix is to withhold any trailing text that could still turn out to be the
 * start of a marker, and to release it once the next chunk proves it is not.
 * Only text that cannot be part of a marker is ever emitted.
 */
export class SectionStreamParser {
  private buf = "";
  private current: SectionKey | null = null;
  /** Text emitted before any marker. Should be empty; kept for diagnostics. */
  readonly preamble: string[] = [];
  readonly unknownMarkers: string[] = [];
  readonly seen: SectionKey[] = [];

  push(chunk: string): SectionDelta[] {
    this.buf += chunk;
    const out: SectionDelta[] = [];

    for (;;) {
      const openIdx = this.buf.indexOf(SECTION_OPEN);

      if (openIdx === -1) {
        // No marker in flight. Emit everything that cannot be a marker prefix.
        const hold = partialSuffixLength(this.buf, SECTION_OPEN);
        const emit = this.buf.slice(0, this.buf.length - hold);
        if (emit.length > 0) this.route(emit, out);
        this.buf = hold > 0 ? this.buf.slice(this.buf.length - hold) : "";
        return out;
      }

      // Text before the marker belongs to the previous section.
      if (openIdx > 0) {
        this.route(this.buf.slice(0, openIdx), out);
      }

      const closeIdx = this.buf.indexOf(SECTION_CLOSE, openIdx + SECTION_OPEN.length);
      if (closeIdx === -1) {
        // Marker started but has not finished arriving. Hold it whole.
        this.buf = this.buf.slice(openIdx);
        return out;
      }

      const key = this.buf.slice(openIdx + SECTION_OPEN.length, closeIdx).trim();
      if (isSectionKey(key)) {
        this.current = key;
        if (!this.seen.includes(key)) this.seen.push(key);
      } else {
        // Keep writing into the previous section rather than dropping text on
        // the floor, and record the anomaly for the caller to reject.
        this.unknownMarkers.push(key);
      }

      this.buf = this.buf.slice(closeIdx + SECTION_CLOSE.length);
      // The prompt puts the body on the line after the marker; drop that one
      // newline so bodies do not all start blank.
      if (this.buf.startsWith("\r\n")) this.buf = this.buf.slice(2);
      else if (this.buf.startsWith("\n")) this.buf = this.buf.slice(1);
    }
  }

  /** Flushes whatever is left once the stream ends. */
  end(): SectionDelta[] {
    const out: SectionDelta[] = [];
    if (this.buf.length > 0) {
      this.route(this.buf, out);
      this.buf = "";
    }
    return out;
  }

  private route(text: string, out: SectionDelta[]): void {
    if (this.current === null) {
      this.preamble.push(text);
      return;
    }
    out.push({ key: this.current, delta: text });
  }
}

export type ParsedSections = {
  bodies: Partial<Record<SectionKey, string>>;
  /** Sections that were expected but never appeared. */
  missing: SectionKey[];
  /** Marker names that are not real section keys. */
  unknownMarkers: string[];
  /** Text the model emitted before the first marker, against instructions. */
  preamble: string;
};

/**
 * Whole-response parse. Uses the same parser as the streaming path — one code
 * path, so the streamed result and the reconciled result cannot disagree.
 */
export function parseSectionedOutput(
  text: string,
  expected: readonly SectionKey[],
): ParsedSections {
  const parser = new SectionStreamParser();
  const deltas = [...parser.push(text), ...parser.end()];

  const bodies: Partial<Record<SectionKey, string>> = {};
  for (const d of deltas) {
    bodies[d.key] = (bodies[d.key] ?? "") + d.delta;
  }
  for (const key of Object.keys(bodies) as SectionKey[]) {
    bodies[key] = bodies[key]?.trim() ?? "";
  }

  return {
    bodies,
    missing: expected.filter((k) => {
      const body = bodies[k];
      return body === undefined || body.length === 0;
    }),
    unknownMarkers: parser.unknownMarkers,
    preamble: parser.preamble.join("").trim(),
  };
}

/**
 * Pulls `[NEEDS INPUT: ...]` markers out of a section body.
 *
 * These become blocking gaps. The marker text stays in the body so the editor
 * can highlight it in place — a gap listed in a side panel but invisible in the
 * document is a gap that gets approved by accident.
 *
 * Nested brackets inside a marker are handled by scanning for the first
 * unmatched close, so "[NEEDS INPUT: which rate (day or hour)?]" survives.
 */
export function extractGaps(sectionKey: SectionKey | null, body: string): GapCandidate[] {
  const gaps: GapCandidate[] = [];
  let cursor = 0;

  for (;;) {
    const start = body.indexOf(GAP_OPEN, cursor);
    if (start === -1) break;

    const contentStart = start + GAP_OPEN.length;
    let depth = 1;
    let i = contentStart;
    while (i < body.length && depth > 0) {
      const ch = body[i];
      if (ch === "[") depth += 1;
      else if (ch === GAP_CLOSE) depth -= 1;
      i += 1;
    }

    if (depth !== 0) {
      // Unterminated marker: the response was truncated or malformed. Report
      // it as a gap of its own rather than silently ignoring the tail.
      const message = "A clarification marker was left unterminated, so this section may be incomplete.";
      gaps.push({
        sectionKey,
        field: null,
        severity: "blocking",
        message,
        detectedBy: "model",
        fingerprint: gapFingerprint({ sectionKey, field: null, message }),
      });
      break;
    }

    const question = body.slice(contentStart, i - 1).trim();
    cursor = i;

    if (question.length === 0) continue;

    const message = question.replace(/\s+/g, " ");
    gaps.push({
      sectionKey,
      field: null,
      severity: "blocking",
      message,
      detectedBy: "model",
      fingerprint: gapFingerprint({ sectionKey, field: null, message }),
    });
  }

  return gaps;
}

/** The `[[source:N]]` indices a section cites, deduplicated, in order. */
export function extractCitationIndices(body: string): number[] {
  const out: number[] = [];
  const re = /\[\[source:(\d{1,3})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Renders a body for a reader: citation markers become superscript-style
 * references, gap markers are left alone (the client-facing renderer refuses to
 * display a proposal with any open gap, so they can never reach a client).
 */
export function stripCitationMarkers(body: string): string {
  return body.replace(/\s*\[\[source:\d{1,3}\]\]/g, "");
}

export function stripGapMarkers(body: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(GAP_OPEN, cursor);
    if (start === -1) {
      out += body.slice(cursor);
      return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
    out += body.slice(cursor, start);
    let depth = 1;
    let i = start + GAP_OPEN.length;
    while (i < body.length && depth > 0) {
      const ch = body[i];
      if (ch === "[") depth += 1;
      else if (ch === GAP_CLOSE) depth -= 1;
      i += 1;
    }
    cursor = depth === 0 ? i : body.length;
  }
}

export function hasGapMarker(body: string): boolean {
  return body.includes(GAP_OPEN);
}
