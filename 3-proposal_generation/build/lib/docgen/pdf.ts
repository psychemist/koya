import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { runsToText, type Block, type DocumentModel, type Inline } from "./markdown";

/**
 * The PDF, typeset by hand with pdf-lib.
 *
 * Why not headless Chrome and print CSS, which would be less code: a Chromium
 * binary does not fit comfortably in a serverless function, and the failure
 * mode when it does not is a cold-start timeout at the moment a client clicks
 * Download. pdf-lib is pure JavaScript, has no binary dependency, and renders
 * in tens of milliseconds. The cost is that line breaking, page breaking and
 * bold runs have to be done explicitly — which is what this file is.
 *
 * The standard PDF fonts are used rather than an embedded typeface, so there
 * is no font file to ship or fail to load. Times for body text and Helvetica
 * for the furniture is a deliberate pairing: a serif body reads as a document
 * rather than a web page, which is what a proposal should feel like.
 */

const A4 = { width: 595.28, height: 841.89 };

/**
 * Margins chosen for the measure, not for the look of the white space. At
 * 11pt Times a 443pt column runs to roughly 80 characters a line, which is
 * inside the 65-80 band that reads comfortably. The earlier 64pt margins gave
 * a 467pt column and about 90 characters, which is wide enough that the eye
 * loses its place returning to the left edge.
 */
const MARGIN = { top: 64, bottom: 72, left: 76, right: 76 };
const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

const INK = rgb(0.06, 0.06, 0.07);
const MUTED = rgb(0.42, 0.42, 0.45);
const RULE = rgb(0.85, 0.85, 0.86);
const ACCENT = rgb(0.16, 0.36, 0.68);

const SIZE = {
  title: 24,
  groupHeading: 13,
  sectionHeading: 11,
  body: 11,
  small: 8.5,
};

/** Leading at roughly 1.5x the body size: airy enough for a long read. */
const LEADING = {
  body: 16.5,
  heading: 17,
};

type Fonts = {
  body: PDFFont;
  bodyBold: PDFFont;
  bodyItalic: PDFFont;
  sans: PDFFont;
  sansBold: PDFFont;
};

/**
 * A cursor that owns pagination.
 *
 * Every write goes through `ensure(height)`, which starts a new page when the
 * next element would cross the bottom margin. Centralising it is what stops
 * text being drawn off the bottom of a page — the classic hand-rolled-PDF bug,
 * and one that only shows up on longer documents.
 */
class Layout {
  page: PDFPage;
  y: number;
  pageNumber = 1;
  private readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
    private readonly footer: string,
  ) {
    this.page = doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN.top;
  }

  ensure(height: number): void {
    if (this.y - height >= MARGIN.bottom) return;
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.pageNumber += 1;
    this.y = A4.height - MARGIN.top;
  }

  gap(height: number): void {
    this.y -= height;
  }

  /** Page numbers are stamped at the end, once the total is known. */
  stampFooters(): void {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      const label = `${this.footer}`;
      page.drawText(label, {
        x: MARGIN.left,
        y: MARGIN.bottom - 24,
        size: SIZE.small,
        font: this.fonts.sans,
        color: MUTED,
      });
      const pageLabel = `${i + 1} of ${total}`;
      const w = this.fonts.sans.widthOfTextAtSize(pageLabel, SIZE.small);
      page.drawText(pageLabel, {
        x: A4.width - MARGIN.right - w,
        y: MARGIN.bottom - 24,
        size: SIZE.small,
        font: this.fonts.sans,
        color: MUTED,
      });
    });
  }
}

/**
 * Breaks a run of inline spans into lines that fit `maxWidth`.
 *
 * Works span by span so a bold phrase can wrap mid-sentence without losing its
 * weight, and measures with the actual font metrics rather than assuming an
 * average character width — the reason a naive wrapper overflows on words like
 * "implementation" and underfills on "it is".
 *
 * A single word longer than the line (a URL, say) is hard-split rather than
 * allowed to overflow the margin.
 */
function wrapRuns(
  runs: readonly Inline[],
  fonts: Fonts,
  size: number,
  maxWidth: number,
): Inline[][] {
  const lines: Inline[][] = [];
  let line: Inline[] = [];
  let width = 0;

  const fontFor = (bold: boolean): PDFFont => (bold ? fonts.bodyBold : fonts.body);

  for (const run of runs) {
    // Keep the spaces as their own tokens so widths stay exact.
    const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0);

    for (const token of tokens) {
      const font = fontFor(run.bold);
      let tokenWidth = font.widthOfTextAtSize(token, size);

      // Never start a line with whitespace.
      if (/^\s+$/.test(token) && line.length === 0) continue;

      if (width + tokenWidth <= maxWidth) {
        appendToken(line, token, run.bold);
        width += tokenWidth;
        continue;
      }

      // Does not fit. Break the line first.
      if (line.length > 0) {
        lines.push(trimLine(line));
        line = [];
        width = 0;
        if (/^\s+$/.test(token)) continue;
        tokenWidth = font.widthOfTextAtSize(token, size);
      }

      // Still too wide on a fresh line: hard-split the word.
      if (tokenWidth > maxWidth) {
        let remainder = token;
        while (remainder.length > 0) {
          let take = remainder.length;
          while (take > 1 && font.widthOfTextAtSize(remainder.slice(0, take), size) > maxWidth) {
            take -= 1;
          }
          lines.push([{ text: remainder.slice(0, take), bold: run.bold }]);
          remainder = remainder.slice(take);
        }
        continue;
      }

      appendToken(line, token, run.bold);
      width += tokenWidth;
    }
  }

  if (line.length > 0) lines.push(trimLine(line));
  return lines;
}

function appendToken(line: Inline[], text: string, bold: boolean): void {
  const last = line[line.length - 1];
  if (last && last.bold === bold) last.text += text;
  else line.push({ text, bold });
}

function trimLine(line: Inline[]): Inline[] {
  const out = line.map((r) => ({ ...r }));
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((r) => r.text.length > 0);
}

function drawLine(
  layout: Layout,
  line: readonly Inline[],
  fonts: Fonts,
  size: number,
  x: number,
): void {
  let cursor = x;
  for (const run of line) {
    const font = run.bold ? fonts.bodyBold : fonts.body;
    layout.page.drawText(run.text, {
      x: cursor,
      y: layout.y,
      size,
      font,
      color: INK,
    });
    cursor += font.widthOfTextAtSize(run.text, size);
  }
}

function drawBlocks(layout: Layout, blocks: readonly Block[], fonts: Fonts): void {
  for (const block of blocks) {
    if (block.kind === "heading") {
      layout.ensure(LEADING.heading + 8);
      layout.gap(10);
      layout.page.drawText(block.text, {
        x: MARGIN.left,
        y: layout.y,
        size: SIZE.sectionHeading,
        font: fonts.sansBold,
        color: INK,
      });
      layout.gap(LEADING.heading);
      continue;
    }

    if (block.kind === "bullet") {
      const indent = 16;
      const lines = wrapRuns(block.runs, fonts, SIZE.body, CONTENT_WIDTH - indent);
      lines.forEach((line, i) => {
        layout.ensure(LEADING.body);
        if (i === 0) {
          // A round bullet drawn as a glyph, not a hyphen — the standard
          // fonts' WinAnsi encoding has no • so it is drawn as a circle.
          layout.page.drawCircle({
            x: MARGIN.left + 4,
            y: layout.y + 3.4,
            size: 1.7,
            color: ACCENT,
          });
        }
        drawLine(layout, line, fonts, SIZE.body, MARGIN.left + indent);
        layout.gap(LEADING.body);
      });
      layout.gap(4);
      continue;
    }

    const lines = wrapRuns(block.runs, fonts, SIZE.body, CONTENT_WIDTH);
    for (const line of lines) {
      layout.ensure(LEADING.body);
      drawLine(layout, line, fonts, SIZE.body, MARGIN.left);
      layout.gap(LEADING.body);
    }
    layout.gap(8);
  }
}

export async function buildProposalPdf(model: DocumentModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  doc.setTitle(`Proposal for ${model.companyName}`);
  doc.setAuthor("Koya Talent");
  doc.setSubject(`Proposal ${model.ref}`);
  doc.setCreator("Koya Proposal Studio");
  doc.setProducer("Koya Proposal Studio");

  const fonts: Fonts = {
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bodyBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    bodyItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const layout = new Layout(doc, fonts, `Koya Talent · ${model.ref}`);

  // ---- Cover block -------------------------------------------------------
  layout.page.drawText("KOYA TALENT", {
    x: MARGIN.left,
    y: layout.y,
    size: SIZE.small,
    font: fonts.sansBold,
    color: ACCENT,
  });
  layout.gap(34);

  layout.page.drawText("Proposal", {
    x: MARGIN.left,
    y: layout.y,
    size: SIZE.title,
    font: fonts.body,
    color: INK,
  });
  layout.gap(28);

  const forLine = `for ${model.companyName}`;
  layout.page.drawText(forLine, {
    x: MARGIN.left,
    y: layout.y,
    size: SIZE.title - 6,
    font: fonts.bodyItalic,
    color: MUTED,
  });
  layout.gap(26);

  layout.page.drawLine({
    start: { x: MARGIN.left, y: layout.y },
    end: { x: A4.width - MARGIN.right, y: layout.y },
    thickness: 0.75,
    color: RULE,
  });
  layout.gap(20);

  const meta: [string, string][] = [
    ["Prepared for", model.clientName],
    ["Prepared by", model.salespersonName],
    ["Date", model.dateLabel],
    ["Reference", model.ref],
  ];
  for (const [label, value] of meta) {
    layout.ensure(14);
    layout.page.drawText(label.toUpperCase(), {
      x: MARGIN.left,
      y: layout.y,
      size: SIZE.small,
      font: fonts.sansBold,
      color: MUTED,
    });
    layout.page.drawText(value, {
      x: MARGIN.left + 110,
      y: layout.y,
      size: SIZE.body,
      font: fonts.body,
      color: INK,
    });
    layout.gap(15);
  }

  layout.gap(14);

  // ---- Sections ----------------------------------------------------------
  let lastGroup = "";
  const groupCounts = new Map<string, number>();
  for (const s of model.sections) {
    groupCounts.set(s.group, (groupCounts.get(s.group) ?? 0) + 1);
  }

  for (const section of model.sections) {
    if (section.group !== lastGroup) {
      // Keep a group heading with at least two lines of the text beneath it,
      // so a heading never sits alone at the foot of a page.
      layout.ensure(LEADING.heading + LEADING.body * 2 + 18);
      layout.gap(14);
      layout.page.drawText(section.group.toUpperCase(), {
        x: MARGIN.left,
        y: layout.y,
        size: SIZE.groupHeading - 2,
        font: fonts.sansBold,
        color: ACCENT,
      });
      layout.gap(8);
      layout.page.drawLine({
        start: { x: MARGIN.left, y: layout.y },
        end: { x: A4.width - MARGIN.right, y: layout.y },
        thickness: 0.5,
        color: RULE,
      });
      layout.gap(16);
      lastGroup = section.group;
    }

    if ((groupCounts.get(section.group) ?? 1) > 1) {
      layout.ensure(LEADING.heading + LEADING.body * 2);
      layout.page.drawText(section.heading, {
        x: MARGIN.left,
        y: layout.y,
        size: SIZE.sectionHeading,
        font: fonts.sansBold,
        color: INK,
      });
      layout.gap(LEADING.heading);
    }

    drawBlocks(layout, section.blocks, fonts);
  }

  layout.stampFooters();
  return doc.save();
}

/** Plain-text rendering, used for the .eml fallback body. */
export function renderPlainText(model: DocumentModel): string {
  const out: string[] = [
    `PROPOSAL FOR ${model.companyName.toUpperCase()}`,
    "",
    `Prepared for: ${model.clientName}`,
    `Prepared by:  ${model.salespersonName}`,
    `Date:         ${model.dateLabel}`,
    `Reference:    ${model.ref}`,
    "",
  ];

  let lastGroup = "";
  for (const section of model.sections) {
    if (section.group !== lastGroup) {
      out.push("", section.group.toUpperCase(), "-".repeat(section.group.length), "");
      lastGroup = section.group;
    }
    for (const block of section.blocks) {
      if (block.kind === "bullet") out.push(`  - ${runsToText(block.runs)}`);
      else if (block.kind === "heading") out.push("", block.text, "");
      else out.push(runsToText(block.runs), "");
    }
  }

  out.push("", `Koya Talent · ${model.ref}`);
  return out.join("\n");
}
