import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ArticleDocument, Block, Inline } from './markdown';

/**
 * The PDF, typeset by hand with pdf-lib. Lifted from 3/build/lib/docgen/pdf.ts.
 *
 * Why not headless Chrome and print CSS, which would be less code: a Chromium
 * binary does not fit comfortably in a serverless function, and the failure
 * mode when it does not is a cold-start timeout at the moment somebody clicks
 * Download. pdf-lib is pure JavaScript, has no binary dependency, and renders
 * in tens of milliseconds. The cost is that line breaking, page breaking and
 * bold runs have to be done explicitly — which is what this file is.
 *
 * The standard PDF fonts are used rather than an embedded typeface, so there
 * is no font file to ship or fail to load. Times for body text and Helvetica
 * for the furniture is the same pairing 3/ uses, and it earns its place twice
 * over here: the review screen already sets the proof in a serif at a 68ch
 * measure precisely so it reads as something printed. A downloaded article
 * that arrived in Helvetica would be a different document from the one the
 * reviewer approved.
 */

const A4 = { width: 595.28, height: 841.89 };

/**
 * Margins chosen for the measure, not for the look of the white space. At
 * 11pt Times a 443pt column runs to roughly 80 characters a line, which is
 * inside the 65-80 band that reads comfortably.
 */
const MARGIN = { top: 64, bottom: 72, left: 76, right: 76 };
const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

const INK = rgb(0.06, 0.06, 0.07);
const MUTED = rgb(0.42, 0.42, 0.45);
const RULE = rgb(0.85, 0.85, 0.86);
const ACCENT = rgb(0.18, 0.29, 0.66);

const SIZE = {
  title: 24,
  sectionHeading: 13,
  subHeading: 11,
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
  sans: PDFFont;
  sansBold: PDFFont;
};

/**
 * A cursor that owns pagination.
 *
 * Every write goes through `ensure(height)`, which starts a new page when the
 * next element would cross the bottom margin. Centralising it is what stops
 * text being drawn off the bottom of a page — the classic hand-rolled-PDF bug,
 * and one that only shows up on longer documents. An article runs to 3,000
 * words, so "only shows up on longer documents" means every single time.
 */
class Layout {
  page: PDFPage;
  y: number;
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
    this.y = A4.height - MARGIN.top;
  }

  gap(height: number): void {
    this.y -= height;
  }

  /** Page numbers are stamped at the end, once the total is known. */
  stampFooters(): void {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      page.drawText(this.footer, {
        x: MARGIN.left, y: MARGIN.bottom - 24,
        size: SIZE.small, font: this.fonts.sans, color: MUTED,
      });
      const pageLabel = `${i + 1} of ${total}`;
      const w = this.fonts.sans.widthOfTextAtSize(pageLabel, SIZE.small);
      page.drawText(pageLabel, {
        x: A4.width - MARGIN.right - w, y: MARGIN.bottom - 24,
        size: SIZE.small, font: this.fonts.sans, color: MUTED,
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
 * A single word longer than the line (a URL, or a `[NEEDS SOURCE: …]` marker)
 * is hard-split rather than allowed to overflow the margin.
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
  if (last) last.text = last.text.replace(/\s+$/, '');
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
    layout.page.drawText(run.text, { x: cursor, y: layout.y, size, font, color: INK });
    cursor += font.widthOfTextAtSize(run.text, size);
  }
}

function drawBlocks(layout: Layout, blocks: readonly Block[], fonts: Fonts): void {
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const size = block.level === 2 ? SIZE.sectionHeading : SIZE.subHeading;
      // Keep a heading with at least one line of what follows it, so a section
      // title never sits alone at the foot of a page.
      layout.ensure(LEADING.heading + LEADING.body + 12);
      layout.gap(12);
      layout.page.drawText(block.text, {
        x: MARGIN.left, y: layout.y, size, font: fonts.sansBold, color: INK,
      });
      layout.gap(LEADING.heading);
      continue;
    }

    if (block.kind === 'bullet') {
      const indent = 16;
      const lines = wrapRuns(block.runs, fonts, SIZE.body, CONTENT_WIDTH - indent);
      lines.forEach((line, i) => {
        layout.ensure(LEADING.body);
        if (i === 0) {
          // A round bullet drawn as a glyph, not a hyphen — the standard
          // fonts' WinAnsi encoding has no • so it is drawn as a circle.
          layout.page.drawCircle({ x: MARGIN.left + 4, y: layout.y + 3.4, size: 1.7, color: ACCENT });
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

export async function buildArticlePdf(model: ArticleDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  doc.setTitle(model.title);
  doc.setAuthor('Koya Content Desk');
  doc.setSubject(`Article revision ${model.revision}`);
  doc.setCreator('Koya Content Desk');
  doc.setProducer('Koya Content Desk');

  const fonts: Fonts = {
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bodyBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  /*
   * The footer names the revision, not just the system.
   *
   * An article goes through up to two automatic revision passes and any
   * number of human edits, every one of them kept. Two PDFs of "the same"
   * article can therefore differ, and without the revision on the page there
   * is nothing on a printed copy that says which one somebody is holding.
   */
  const layout = new Layout(
    doc, fonts,
    `Koya Content Desk · revision ${model.revision} · ${model.dateLabel}`,
  );

  // ---- title ----
  const titleFonts: Fonts = { ...fonts, body: fonts.sansBold, bodyBold: fonts.sansBold };
  const titleLines = wrapRuns(
    [{ text: model.title, bold: false }], titleFonts, SIZE.title, CONTENT_WIDTH);
  for (const line of titleLines) {
    layout.ensure(SIZE.title + 8);
    layout.page.drawText(line.map((r) => r.text).join(''), {
      x: MARGIN.left, y: layout.y, size: SIZE.title, font: fonts.sansBold, color: INK,
    });
    layout.gap(SIZE.title + 6);
  }

  layout.gap(6);
  layout.page.drawLine({
    start: { x: MARGIN.left, y: layout.y },
    end: { x: A4.width - MARGIN.right, y: layout.y },
    thickness: 0.75,
    color: RULE,
  });
  layout.gap(20);

  drawBlocks(layout, model.blocks, fonts);
  layout.stampFooters();

  return doc.save();
}
