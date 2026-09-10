import type { ReactNode } from "react";
import { parseBlocks, parseInline, type Block, type Inline } from "../lib/docgen/markdown";
import { GAP_OPEN } from "../lib/claude/prompts";

/**
 * Renders a section body as document prose.
 *
 * Deliberately reuses `parseBlocks` from the PDF and DOCX pipeline rather than
 * pulling in a markdown library. One parser means the web page, the PDF and
 * the Word file cannot render the same section differently — which is the sort
 * of divergence a client notices and you do not.
 *
 * `showGaps` is the important switch. Internally, a `[NEEDS INPUT: ...]`
 * marker is rendered in place as a highlighted chip, because a gap listed in a
 * side panel but invisible in the document is a gap that gets approved by
 * accident. On the client-facing page markers are stripped — and the send path
 * additionally refuses to run while any blocking gap is open, so that is the
 * second of two independent defences rather than the only one.
 *
 * CITATIONS ARE THE SAME PROBLEM IN REVERSE. `[[source:1]]` is how the model
 * says "that figure came from the first attachment". Everything client-facing
 * strips it; the workspace did not render it either, so it arrived on screen
 * as the literal characters `[[source:1]]` in the middle of a sentence about
 * payment terms. That is unreadable, and worse, it is unusable: the one place
 * where knowing which upload a number came from actually matters is the
 * screen where somebody is deciding whether to sign it off. It now renders as
 * a chip naming the file.
 */

export type CitationTarget = { index: number; filename: string };

const SOURCE_MARKER = /\[\[source:(\d+)\]\]/;

type Segment =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "gap"; question: string }
  | { kind: "source"; index: number };

/**
 * Splits inline runs on gap markers, preserving bold state across the split.
 *
 * Bracket depth is tracked so a question containing brackets — "which rate
 * (day or hour)?" — is not truncated at the first close bracket.
 */
function splitGaps(runs: readonly Inline[]): Segment[] {
  const out: Segment[] = [];

  for (const run of runs) {
    let cursor = 0;
    for (;;) {
      const start = run.text.indexOf(GAP_OPEN, cursor);
      if (start === -1) {
        if (cursor < run.text.length) {
          out.push({ kind: "text", text: run.text.slice(cursor), bold: run.bold });
        }
        break;
      }

      if (start > cursor) {
        out.push({ kind: "text", text: run.text.slice(cursor, start), bold: run.bold });
      }

      let depth = 1;
      let i = start + GAP_OPEN.length;
      while (i < run.text.length && depth > 0) {
        const ch = run.text[i];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        i += 1;
      }

      const question = run.text.slice(start + GAP_OPEN.length, depth === 0 ? i - 1 : i).trim();
      out.push({ kind: "gap", question });
      cursor = i;
      if (depth !== 0) break;
    }
  }

  return out;
}

/**
 * Second pass, over the text segments only.
 *
 * Run after the gap split rather than inside it, because a citation can sit
 * inside a gap question ("what is the rate on [[source:2]]?") and that text
 * belongs to the question, not to the prose.
 */
function splitSources(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind !== "text") {
      out.push(seg);
      continue;
    }
    let rest = seg.text;
    for (;;) {
      const m = SOURCE_MARKER.exec(rest);
      if (!m) {
        if (rest.length > 0) out.push({ kind: "text", text: rest, bold: seg.bold });
        break;
      }
      if (m.index > 0) {
        out.push({ kind: "text", text: rest.slice(0, m.index), bold: seg.bold });
      }
      out.push({ kind: "source", index: Number(m[1]) });
      rest = rest.slice(m.index + m[0].length);
    }
  }
  return out;
}

function renderSegments(
  runs: readonly Inline[],
  showGaps: boolean,
  sources: readonly CitationTarget[],
): ReactNode[] {
  const segments = splitSources(splitGaps(runs));
  return segments.map((seg, i) => {
    if (seg.kind === "gap") {
      if (!showGaps) return null;
      return (
        <mark key={i} className="gap-marker" title={seg.question}>
          {/* Glyph, colour and the word "needs" — three signals, so the
              highlight survives greyscale and colour blindness. */}
          <span aria-hidden="true">▲ </span>
          <span className="sr-only">Needs input: </span>
          {seg.question}
        </mark>
      );
    }
    if (seg.kind === "source") {
      // Client-facing renders strip citations along with gap markers: the
      // client does not need to be told which of their own documents a
      // figure came from, and the numbering leaks how many were uploaded.
      if (!showGaps) return null;
      const match = sources.find((s) => s.index === seg.index);
      const label = match ? match.filename : `attachment ${seg.index}`;
      return (
        <span
          key={i}
          className="source-chip"
          title={
            match
              ? `Taken from ${match.filename}, attachment ${seg.index}.`
              : `Cites attachment ${seg.index}, which is no longer on this proposal.`
          }
        >
          <span aria-hidden="true">◇</span>
          <span className="sr-only">Source: </span>
          {shortName(label)}
        </span>
      );
    }
    if (seg.text.length === 0) return null;
    return seg.bold ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>;
  });
}

/** Filenames run long. The chip carries the short form; the title has it all. */
function shortName(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]{1,5}$/i, "");
  return base.length <= 22 ? base : `${base.slice(0, 21)}…`;
}

function renderBlock(
  block: Block,
  index: number,
  showGaps: boolean,
  sources: readonly CitationTarget[],
): ReactNode {
  if (block.kind === "heading") {
    return <h3 key={index}>{block.text}</h3>;
  }
  if (block.kind === "bullet") {
    // Consecutive bullets are grouped by the caller below.
    return <li key={index}>{renderSegments(block.runs, showGaps, sources)}</li>;
  }
  return <p key={index}>{renderSegments(block.runs, showGaps, sources)}</p>;
}

export function DocumentBody({
  bodyMd,
  showGaps = true,
  sources = [],
}: {
  bodyMd: string;
  showGaps?: boolean;
  sources?: readonly CitationTarget[];
}) {
  const blocks = parseBlocks(bodyMd);
  const nodes: ReactNode[] = [];

  // Group runs of bullets into a single <ul>. Emitting one list per bullet
  // would be wrong semantically and would break the spacing rhythm.
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.kind === "bullet") {
      const items: ReactNode[] = [];
      while (i < blocks.length && blocks[i]!.kind === "bullet") {
        items.push(renderBlock(blocks[i]!, i, showGaps, sources));
        i += 1;
      }
      nodes.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }
    nodes.push(renderBlock(block, i, showGaps, sources));
    i += 1;
  }

  return <>{nodes}</>;
}

/**
 * Streaming variant. Takes raw text that may end mid-word or mid-marker and
 * renders what is safely renderable, with a caret at the end.
 *
 * The half-arrived marker case is handled by not rendering the tail from an
 * unterminated `[NEEDS INPUT:` onwards — otherwise the reader watches the
 * literal string "[NEEDS INPUT: what is the" appear character by character,
 * which looks like a bug even though it is not.
 */
export function StreamingBody({
  text,
  sources = [],
}: {
  text: string;
  sources?: readonly CitationTarget[];
}) {
  const lastOpen = text.lastIndexOf(GAP_OPEN);
  const safe =
    lastOpen !== -1 && !text.slice(lastOpen).includes("]") ? text.slice(0, lastOpen) : text;

  const blocks = parseBlocks(safe);
  const nodes: ReactNode[] = [];

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    const isLast = i === blocks.length - 1;

    if (block.kind === "bullet") {
      const items: ReactNode[] = [];
      while (i < blocks.length) {
        const current = blocks[i];
        if (!current || current.kind !== "bullet") break;
        // The caret rides the final bullet, which is the one still arriving.
        const isFinal = i === blocks.length - 1;
        items.push(
          <li key={i} className={isFinal ? "stream-caret" : undefined}>
            {renderSegments(current.runs, true, sources)}
          </li>,
        );
        i += 1;
      }
      nodes.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }

    if (block.kind === "heading") {
      nodes.push(<h3 key={i}>{block.text}</h3>);
      i += 1;
      continue;
    }

    nodes.push(
      <p key={i} className={isLast ? "stream-caret" : undefined}>
        {renderSegments(block.runs, true, sources)}
      </p>,
    );
    i += 1;
  }

  if (nodes.length === 0) {
    return <p className="stream-caret m-0" />;
  }

  return <>{nodes}</>;
}

/** Fallback used before a section has any text at all. */
export function SectionSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-[13px]"
          style={{ width: i === lines - 1 ? "62%" : "100%" }}
        />
      ))}
    </div>
  );
}
