import { stripCitations } from '../publish/citations';

/**
 * Turning a stored article into a document.
 *
 * The block model and the two parsers below are lifted from 3/build's
 * lib/docgen/markdown.ts, which exists for the same reason it does here:
 * every output format is built from ONE block model. Writing a separate
 * renderer per format is how a PDF ends up saying something the review screen
 * does not, and the reader notices before you do.
 *
 * What is NOT lifted is the document model itself. 3/ builds a proposal —
 * client, company, salesperson, reference, sections keyed to a fixed template.
 * An article is a title and a run of sections, and pretending otherwise would
 * mean carrying five empty fields through every renderer.
 */

export type Inline = { text: string; bold: boolean };

export type Block =
  | { kind: 'paragraph'; runs: Inline[] }
  | { kind: 'bullet'; runs: Inline[] }
  | { kind: 'heading'; level: 2 | 3; text: string };

/**
 * Splits a line into bold and plain runs.
 *
 * Handles `**bold**` only. An unclosed `**` is treated as literal text rather
 * than turning the remainder of the document bold — a malformed emphasis
 * marker should cost one ugly pair of asterisks, not the rest of the page.
 */
export function parseInline(line: string): Inline[] {
  const runs: Inline[] = [];
  let cursor = 0;

  for (;;) {
    const open = line.indexOf('**', cursor);
    if (open === -1) break;
    const close = line.indexOf('**', open + 2);
    if (close === -1) break; // unclosed: fall through and emit the rest as-is

    if (open > cursor) runs.push({ text: line.slice(cursor, open), bold: false });
    const inner = line.slice(open + 2, close);
    if (inner.length > 0) runs.push({ text: inner, bold: true });
    cursor = close + 2;
  }

  if (cursor < line.length) runs.push({ text: line.slice(cursor), bold: false });
  return runs.filter((r) => r.text.length > 0);
}

/** Parses a body into blocks. */
export function parseBlocks(bodyMd: string): Block[] {
  const blocks: Block[] = [];
  const lines = bodyMd.replace(/\r\n?/g, '\n').split('\n');

  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    if (text.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(text) });
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: 'bullet', runs: parseInline((bullet[1] ?? '').trim()) });
      continue;
    }

    const heading = /^\s*(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '##').length >= 3 ? 3 : 2,
        text: (heading[2] ?? '').trim(),
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

export type ArticleDocument = {
  title: string;
  blocks: Block[];
  /** Printed in the furniture so a downloaded file can be traced back. */
  requestId: string;
  revision: number;
  dateLabel: string;
};

/**
 * Builds the document from a stored article asset.
 *
 * CITATION MARKERS COME OFF. `[S1d20P1]` is an excerpt label the grounding
 * check reads and a reviewer follows a figure back through. It is apparatus,
 * it is stripped at the publish boundary for exactly this reason, and a
 * downloaded file is no different — somebody emails this to a client.
 *
 * `[NEEDS SOURCE: …]` MARKERS STAY, and that is not an oversight. The rule
 * this system runs on is that removing only the marker leaves the sentence
 * with a hole where its evidence should be, which reads as finished prose and
 * is not. A download carrying a visible gap is a draft that says so; a
 * download with the gap quietly deleted is the failure the marker exists to
 * prevent. If it should not go out with gaps in it, it should not be approved
 * with gaps in it, and that gate already exists.
 */
export function buildArticleDocument(args: {
  body: string;
  requestId: string;
  revision: number;
  now?: Date;
}): ArticleDocument {
  const cleaned = stripCitations(args.body);
  const lines = cleaned.replace(/\r\n?/g, '\n').split('\n');

  // The generator writes `# Title` as the first line (lib/pipeline/generate.ts).
  // It is the document's title rather than a heading inside it, so it comes
  // out here and the rest is parsed as body.
  let title = 'Untitled article';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      title = (h1[1] ?? '').trim() || title;
      start = i + 1;
    }
    break;
  }

  const date = args.now ?? new Date();
  return {
    title,
    blocks: parseBlocks(lines.slice(start).join('\n')),
    requestId: args.requestId,
    revision: args.revision,
    dateLabel: date.toISOString().slice(0, 10),
  };
}

/** Flattens runs back to plain text. */
export function runsToText(runs: readonly Inline[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * The Markdown deliverable — what somebody pastes into a CMS.
 *
 * Rebuilt from the block model rather than handed back the stored body, so it
 * is the same document the PDF renders. Returning the raw body would be one
 * line of code and would ship the citation markers the PDF strips.
 */
export function renderMarkdown(model: ArticleDocument): string {
  const out: string[] = [`# ${model.title}`, ''];

  for (const block of model.blocks) {
    if (block.kind === 'paragraph') {
      out.push(inlineToMarkdown(block.runs), '');
    } else if (block.kind === 'bullet') {
      out.push(`- ${inlineToMarkdown(block.runs)}`);
    } else {
      out.push(`${'#'.repeat(block.level)} ${block.text}`, '');
    }
  }

  // A bullet run needs a blank line after it before the rule.
  if (out[out.length - 1] !== '') out.push('');
  out.push('---', '', `Koya Content Desk · revision ${model.revision} · ${model.dateLabel}`, '');

  return out.join('\n');
}

function inlineToMarkdown(runs: readonly Inline[]): string {
  return runs.map((r) => (r.bold ? `**${r.text}**` : r.text)).join('');
}
