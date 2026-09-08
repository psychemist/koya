import { stripCitationMarkers, stripGapMarkers } from "../proposal/parse";
import { formatCallDate, type Intake } from "../proposal/intake";
import { SECTIONS, type SectionKey } from "../proposal/sections";

/**
 * Turning stored sections into a document.
 *
 * Every output format — Markdown, PDF, DOCX, the client-facing web page — is
 * built from this one block model. Writing four independent renderers is how a
 * PDF ends up saying something the web page does not, and the client notices
 * before you do.
 *
 * The markdown Claude produces is deliberately restricted (paragraphs, bullet
 * lists, bold, nothing else — see prompts.ts), so this parser only has to
 * handle that subset. It is not a general Markdown implementation and does not
 * pretend to be one.
 */

export type Inline = { text: string; bold: boolean };

export type Block =
  | { kind: "paragraph"; runs: Inline[] }
  | { kind: "bullet"; runs: Inline[] }
  | { kind: "heading"; level: 2 | 3; text: string };

export type RenderedSection = {
  key: SectionKey;
  heading: string;
  group: string;
  blocks: Block[];
};

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
    const open = line.indexOf("**", cursor);
    if (open === -1) break;
    const close = line.indexOf("**", open + 2);
    if (close === -1) break; // unclosed: fall through and emit the rest as-is

    if (open > cursor) runs.push({ text: line.slice(cursor, open), bold: false });
    const inner = line.slice(open + 2, close);
    if (inner.length > 0) runs.push({ text: inner, bold: true });
    cursor = close + 2;
  }

  if (cursor < line.length) runs.push({ text: line.slice(cursor), bold: false });
  return runs.filter((r) => r.text.length > 0);
}

/** Parses one section body into blocks. */
export function parseBlocks(bodyMd: string): Block[] {
  const blocks: Block[] = [];
  const lines = bodyMd.replace(/\r\n?/g, "\n").split("\n");

  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text.length > 0) blocks.push({ kind: "paragraph", runs: parseInline(text) });
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
      blocks.push({ kind: "bullet", runs: parseInline((bullet[1] ?? "").trim()) });
      continue;
    }

    // The prompt forbids headings inside a section, but a model occasionally
    // emits one anyway. Rendering it as a sub-heading is better than showing
    // the reader a literal "### ".
    const heading = /^\s*(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "##").length >= 3 ? 3 : 2,
        text: (heading[2] ?? "").trim(),
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

export type DocumentModel = {
  clientName: string;
  companyName: string;
  salespersonName: string;
  dateLabel: string;
  ref: string;
  sections: RenderedSection[];
};

/**
 * Builds the document model.
 *
 * `forClient` is the important flag. When true, gap markers are stripped —
 * a `[NEEDS INPUT: ...]` question is an internal note and must never appear in
 * front of a client. The send path additionally refuses to run at all while
 * any blocking gap is open, so this is the second of two defences rather than
 * the only one.
 *
 * Citation markers are stripped in both modes: `[[source:2]]` is scaffolding
 * for the grounding gate, not something a reader should see. The workspace
 * shows citations through its own UI, from the `citations` table.
 */
export function buildDocumentModel(args: {
  ref: string;
  intake: Intake;
  sections: readonly { key: SectionKey; heading: string; body_md: string }[];
  forClient: boolean;
}): DocumentModel {
  const bodyByKey = new Map(args.sections.map((s) => [s.key, s.body_md]));

  const sections: RenderedSection[] = SECTIONS.map((def) => {
    const raw = bodyByKey.get(def.key) ?? "";
    const cleaned = args.forClient
      ? stripCitationMarkers(stripGapMarkers(raw))
      : stripCitationMarkers(raw);
    return {
      key: def.key,
      heading: def.heading,
      group: def.group,
      blocks: parseBlocks(cleaned),
    };
  }).filter((s) => s.blocks.length > 0);

  return {
    clientName: args.intake.client_name,
    companyName: args.intake.company_name,
    salespersonName: args.intake.salesperson_name,
    dateLabel: formatCallDate(args.intake.date_of_call),
    ref: args.ref,
    sections,
  };
}

/** Flattens runs back to plain text. Used by DOCX alt text and the .eml body. */
export function runsToText(runs: readonly Inline[]): string {
  return runs.map((r) => r.text).join("");
}

/**
 * The Markdown deliverable, following assets/proposal-template.md.
 *
 * This is what "generated proposal sample" in the deliverables means, and it
 * is also the format a salesperson pastes into a CRM.
 */
export function renderMarkdown(model: DocumentModel): string {
  const out: string[] = [];

  out.push(`# Proposal for ${model.clientName}`);
  out.push("");
  out.push(`Prepared by ${model.salespersonName}`);
  out.push("");
  out.push(`Date: ${model.dateLabel}`);
  out.push("");
  out.push(`Reference: ${model.ref}`);
  out.push("");

  // Group headings mirror the template: "2. Proposed Solution" appears once,
  // with Project Scope and Recommended Approach nested beneath it. A group
  // holding a single section needs no sub-heading, because the group heading
  // already names it.
  const sectionsPerGroup = new Map<string, number>();
  for (const s of model.sections) {
    sectionsPerGroup.set(s.group, (sectionsPerGroup.get(s.group) ?? 0) + 1);
  }

  let lastGroup = "";
  for (const section of model.sections) {
    if (section.group !== lastGroup) {
      out.push(`## ${section.group}`);
      out.push("");
      lastGroup = section.group;
    }
    if ((sectionsPerGroup.get(section.group) ?? 1) > 1) {
      out.push(`### ${section.heading}`);
      out.push("");
    }

    for (const block of section.blocks) {
      if (block.kind === "paragraph") {
        out.push(inlineToMarkdown(block.runs));
        out.push("");
      } else if (block.kind === "bullet") {
        out.push(`- ${inlineToMarkdown(block.runs)}`);
      } else {
        out.push(`${"#".repeat(block.level + 1)} ${block.text}`);
        out.push("");
      }
    }
    // A bullet run needs a blank line after it before the next block.
    if (out[out.length - 1] !== "") out.push("");
  }

  out.push("---");
  out.push("");
  out.push(`Koya Talent · ${model.ref}`);
  out.push("");

  return out.join("\n");
}

function inlineToMarkdown(runs: readonly Inline[]): string {
  return runs.map((r) => (r.bold ? `**${r.text}**` : r.text)).join("");
}
