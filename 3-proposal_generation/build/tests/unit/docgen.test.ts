import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  parseInline,
  parseBlocks,
  buildDocumentModel,
  renderMarkdown,
} from "../../lib/docgen/markdown";
import { buildProposalPdf, renderPlainText } from "../../lib/docgen/pdf";
import { buildProposalDocx } from "../../lib/docgen/docx";
import { COMPLETE_INTAKE } from "../../fixtures/intakes";
import type { SectionKey } from "../../lib/proposal/sections";

const SECTIONS: { key: SectionKey; heading: string; body_md: string }[] = [
  {
    key: "introduction",
    heading: "Introduction",
    body_md:
      "Thank you for your time on 14 August. Your dispatch team rekeys every delivery note by hand [[source:1]], and it is costing you credit notes.",
  },
  {
    key: "project_scope",
    heading: "Project Scope",
    body_md: "In scope:\n\n- Capture from the shared inbox\n- Validation against the order\n\nOut of scope: invoicing.",
  },
  {
    key: "recommended_approach",
    heading: "Recommended Approach",
    body_md: "Three phases. **Phase one** is discovery.",
  },
  {
    key: "pricing",
    heading: "Pricing",
    body_md: "The fee is **£48,000** fixed. [NEEDS INPUT: is VAT included in this figure?]",
  },
  { key: "next_steps", heading: "Next Steps", body_md: "We will send an agreement." },
];

// ------------------------------------------------------------------- inline

test("bold runs are parsed", () => {
  assert.deepEqual(parseInline("a **b** c"), [
    { text: "a ", bold: false },
    { text: "b", bold: true },
    { text: " c", bold: false },
  ]);
});

test("an unclosed bold marker does not make the rest of the document bold", () => {
  // The whole point: one malformed marker costs a pair of asterisks, not the
  // remainder of the proposal.
  const runs = parseInline("the fee is **48,000 and it covers everything");
  assert.equal(runs.every((r) => !r.bold), true);
  assert.equal(runs.map((r) => r.text).join(""), "the fee is **48,000 and it covers everything");
});

test("text with no markers is a single plain run", () => {
  assert.deepEqual(parseInline("plain text"), [{ text: "plain text", bold: false }]);
});

// ------------------------------------------------------------------- blocks

test("paragraphs, bullets and stray headings are all recognised", () => {
  const blocks = parseBlocks("Intro para.\n\n- one\n- two\n\n## Stray\n\nAfter.");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["paragraph", "bullet", "bullet", "heading", "paragraph"],
  );
});

test("soft-wrapped lines join into one paragraph", () => {
  const blocks = parseBlocks("This sentence was\nwrapped by the model\nacross three lines.");
  assert.equal(blocks.length, 1);
  assert.equal(
    blocks[0]?.kind === "paragraph" ? blocks[0].runs[0]?.text : "",
    "This sentence was wrapped by the model across three lines.",
  );
});

test("bullets written with asterisks or bullets characters are recognised", () => {
  for (const marker of ["-", "*", "•"]) {
    const blocks = parseBlocks(`${marker} an item`);
    assert.equal(blocks[0]?.kind, "bullet", marker);
  }
});

// ------------------------------------------------------------ document model

test("the client-facing model strips gap markers", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0001",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const all = JSON.stringify(model);
  assert.ok(!all.includes("NEEDS INPUT"), "a gap marker must never reach a client document");
  assert.ok(!all.includes("source:"), "citation scaffolding must not reach a client document");
});

test("the internal model keeps gap markers so the editor can highlight them", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0001",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: false,
  });
  assert.ok(JSON.stringify(model).includes("NEEDS INPUT"));
});

test("empty sections are dropped from the document", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0002",
    intake: COMPLETE_INTAKE,
    sections: [
      { key: "introduction", heading: "Introduction", body_md: "Real." },
      { key: "pricing", heading: "Pricing", body_md: "   " },
    ],
    forClient: true,
  });
  assert.deepEqual(model.sections.map((s) => s.key), ["introduction"]);
});

test("sections render in template order regardless of input order", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0003",
    intake: COMPLETE_INTAKE,
    sections: [...SECTIONS].reverse(),
    forClient: true,
  });
  assert.deepEqual(
    model.sections.map((s) => s.key),
    ["introduction", "project_scope", "recommended_approach", "pricing", "next_steps"],
  );
});

// ----------------------------------------------------------------- markdown

test("markdown carries the header, groups and content", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0004",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const md = renderMarkdown(model);
  assert.match(md, /^# Proposal for Amara Diallo/m);
  assert.match(md, /Prepared by Ada Okonkwo/);
  assert.match(md, /## 1\. Introduction/);
  assert.match(md, /## 2\. Proposed Solution/);
  // The two-section group gets sub-headings; a one-section group does not.
  assert.match(md, /### Project Scope/);
  assert.match(md, /### Recommended Approach/);
  assert.ok(!md.includes("### Introduction"), "a single-section group needs no sub-heading");
  assert.match(md, /- Capture from the shared inbox/);
  assert.match(md, /\*\*£48,000\*\*/);
  assert.ok(!md.includes("NEEDS INPUT"));
});

test("plain text rendering is readable and complete", () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0005",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const txt = renderPlainText(model);
  assert.match(txt, /PROPOSAL FOR MERIDIAN LOGISTICS/);
  assert.match(txt, /Reference:    KOY-2026-0005/);
  assert.match(txt, /- Capture from the shared inbox/);
  assert.ok(!txt.includes("**"), "plain text must not carry markdown emphasis");
});

// ---------------------------------------------------------------------- pdf

test("the PDF is a valid document with metadata and readable page count", async () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0006",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const bytes = await buildProposalPdf(model);

  // %PDF magic.
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString("latin1"), "%PDF");
  assert.ok(bytes.byteLength > 2000, `suspiciously small: ${bytes.byteLength} bytes`);

  // Parse it back — the strongest available check that it is well-formed.
  const reparsed = await PDFDocument.load(bytes);
  assert.ok(reparsed.getPageCount() >= 1);
  assert.equal(reparsed.getTitle(), "Proposal for Meridian Logistics");
  assert.equal(reparsed.getAuthor(), "Koya Talent");
});

test("a long proposal paginates instead of overflowing one page", async () => {
  // Twelve substantial paragraphs must not fit on a single A4 page. If they
  // do, the layout is drawing text past the bottom margin.
  const long = Array.from(
    { length: 12 },
    (_, i) =>
      `Paragraph ${i + 1}. ${"This sentence exists to consume vertical space on the page and force the layout engine to break across pages. ".repeat(4)}`,
  ).join("\n\n");

  const model = buildDocumentModel({
    ref: "KOY-2026-0007",
    intake: COMPLETE_INTAKE,
    sections: [{ key: "recommended_approach", heading: "Recommended Approach", body_md: long }],
    forClient: true,
  });
  const bytes = await buildProposalPdf(model);
  const reparsed = await PDFDocument.load(bytes);
  assert.ok(reparsed.getPageCount() >= 2, `expected pagination, got ${reparsed.getPageCount()} page`);
});

test("an unbreakably long token does not crash the layout", async () => {
  // A pasted URL with no spaces. The wrapper must hard-split it rather than
  // loop for ever or draw past the margin.
  const model = buildDocumentModel({
    ref: "KOY-2026-0008",
    intake: COMPLETE_INTAKE,
    sections: [
      {
        key: "introduction",
        heading: "Introduction",
        body_md: `See ${"x".repeat(400)} for details.`,
      },
    ],
    forClient: true,
  });
  const bytes = await buildProposalPdf(model);
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test("generating the same PDF twice is deterministic in size", async () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0009",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const a = await buildProposalPdf(model);
  const b = await buildProposalPdf(model);
  // Byte-identity would require pinning the creation date, which pdf-lib sets;
  // equal length is enough to catch non-deterministic layout.
  assert.equal(a.byteLength, b.byteLength);
});

// --------------------------------------------------------------------- docx

test("the DOCX is a valid zip container of plausible size", async () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0010",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  const bytes = await buildProposalDocx(model);

  // PK zip magic — a .docx is a zip archive.
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.ok(bytes.byteLength > 3000, `suspiciously small: ${bytes.byteLength} bytes`);

  // The document text should be somewhere inside the (compressed) archive's
  // uncompressed XML part names at minimum.
  const asLatin = Buffer.from(bytes).toString("latin1");
  assert.match(asLatin, /word\/document\.xml/);
});

test("the DOCX carries no gap markers when built for a client", async () => {
  const model = buildDocumentModel({
    ref: "KOY-2026-0011",
    intake: COMPLETE_INTAKE,
    sections: SECTIONS,
    forClient: true,
  });
  // Checked on the model rather than the compressed bytes: the zip would hide
  // the string, and the model is what the renderer is handed.
  assert.ok(!JSON.stringify(model).includes("NEEDS INPUT"));
  const bytes = await buildProposalDocx(model);
  assert.ok(bytes.byteLength > 0);
});
