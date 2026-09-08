import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { Block, DocumentModel, Inline } from "./markdown";

/**
 * The DOCX, for the salesperson who needs to hand-edit before sending or drop
 * the text into a client's own template.
 *
 * Built from the same block model as the PDF and the web page, so the three
 * cannot drift apart. Styling is deliberately conservative — Word documents
 * get opened in every version of Word there is, and a clean built-in style
 * survives that better than a clever one.
 */

const FONT_BODY = "Georgia";
const FONT_SANS = "Segoe UI";
const INK = "111114";
const MUTED = "6B6B70";
const ACCENT = "295CAE";

function runs(inline: readonly Inline[], opts: { size?: number } = {}): TextRun[] {
  return inline.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        font: FONT_BODY,
        // docx sizes are in half-points, so 21 is 10.5pt.
        size: opts.size ?? 21,
        color: INK,
      }),
  );
}

function blockToParagraphs(block: Block): Paragraph[] {
  if (block.kind === "heading") {
    return [
      new Paragraph({
        spacing: { before: 200, after: 100 },
        children: [
          new TextRun({
            text: block.text,
            bold: true,
            font: FONT_SANS,
            size: 22,
            color: INK,
          }),
        ],
      }),
    ];
  }

  if (block.kind === "bullet") {
    return [
      new Paragraph({
        // The built-in bullet numbering, so the list behaves like a real Word
        // list when the recipient edits it.
        bullet: { level: 0 },
        spacing: { after: 80, line: 300 },
        children: runs(block.runs),
      }),
    ];
  }

  return [
    new Paragraph({
      spacing: { after: 180, line: 300 },
      children: runs(block.runs),
    }),
  ];
}

export async function buildProposalDocx(model: DocumentModel): Promise<Uint8Array> {
  const children: Paragraph[] = [];

  // ---- Cover -------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({ text: "KOYA TALENT", bold: true, font: FONT_SANS, size: 17, color: ACCENT }),
      ],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: "Proposal", font: FONT_BODY, size: 48, color: INK })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `for ${model.companyName}`,
          italics: true,
          font: FONT_BODY,
          size: 32,
          color: MUTED,
        }),
      ],
    }),
  );

  for (const [label, value] of [
    ["Prepared for", model.clientName],
    ["Prepared by", model.salespersonName],
    ["Date", model.dateLabel],
    ["Reference", model.ref],
  ] as const) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({
            text: `${label.toUpperCase()}   `,
            bold: true,
            font: FONT_SANS,
            size: 16,
            color: MUTED,
          }),
          new TextRun({ text: value, font: FONT_BODY, size: 21, color: INK }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      spacing: { before: 240, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D8D8DC", space: 1 } },
      children: [],
    }),
  );

  // ---- Sections ----------------------------------------------------------
  const groupCounts = new Map<string, number>();
  for (const s of model.sections) {
    groupCounts.set(s.group, (groupCounts.get(s.group) ?? 0) + 1);
  }

  let lastGroup = "";
  for (const section of model.sections) {
    if (section.group !== lastGroup) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 320, after: 160 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D8D8DC", space: 4 } },
          children: [
            new TextRun({
              text: section.group.toUpperCase(),
              bold: true,
              font: FONT_SANS,
              size: 22,
              color: ACCENT,
            }),
          ],
        }),
      );
      lastGroup = section.group;
    }

    if ((groupCounts.get(section.group) ?? 1) > 1) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 160, after: 100 },
          children: [
            new TextRun({
              text: section.heading,
              bold: true,
              font: FONT_SANS,
              size: 22,
              color: INK,
            }),
          ],
        }),
      );
    }

    for (const block of section.blocks) {
      children.push(...blockToParagraphs(block));
    }
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480 },
      children: [
        new TextRun({
          text: `Koya Talent · ${model.ref}`,
          font: FONT_SANS,
          size: 16,
          color: MUTED,
        }),
      ],
    }),
  );

  const doc = new Document({
    title: `Proposal for ${model.companyName}`,
    creator: "Koya Proposal Studio",
    description: `Proposal ${model.ref}`,
    sections: [
      {
        properties: {
          page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } },
        },
        children,
      },
    ],
  });

  // Packer returns a Buffer in Node; normalise to Uint8Array so the route
  // handlers all deal in one type.
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
