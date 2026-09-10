import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "./client";
import { AppError, ErrorCode } from "../errors";

/**
 * Reading a PDF that has no text layer.
 *
 * A scanned invoice or a photographed brief opens fine, has pages, and yields
 * nothing to a text extractor. Until now that was the end of the road: the
 * source was marked `empty` and the salesperson was told to run it through OCR
 * themselves — correct behaviour, in that it never pretended to have read the
 * file, but it made the upload useless for the one class of document that is
 * most often handed over as a scan.
 *
 * NO OCR LIBRARY IS INVOLVED. The PDF is sent to Claude as a `document`
 * content block and the model's vision reads the page images directly. That
 * choice follows the same rule as the rest of this build: nothing that needs
 * a native module, a headless browser, or a binary to be present on a
 * serverless function at cold start. Tesseract would have been a native
 * dependency; rendering pages to images first would have needed a canvas
 * implementation. This needs neither — it is one more API call over a
 * transport the application already speaks.
 *
 * WHAT MAKES THIS DANGEROUS, AND WHAT HOLDS IT.
 *
 * The grounding gate works by checking every figure in the draft against the
 * intake and the sources. OCR output BECOMES a source. So a misread figure is
 * not caught by the gate — it is laundered by it: the gate confirms that
 * "GBP 4,000" appears in the source material, which it now does, because the
 * transcription put it there when the page said GBP 40,000.
 *
 * Three things answer that, and none of them is the model trying harder:
 *
 *   1. The transcript is labelled as transcribed, in the source itself, so the
 *      grounding judge and the drafting call both know its provenance.
 *   2. An advisory gap is raised on the proposal telling the reviewer to check
 *      the figures against the original document.
 *   3. The approver sees both, before anything reaches a client.
 *
 * The honest summary is that OCR moves a scan from "contributes nothing" to
 * "contributes something a human must verify". That is an improvement, and it
 * is not the same as trusting it.
 */

/**
 * Page ceiling for transcription, deliberately far below the extraction limit
 * of 60 pages.
 *
 * Every page is an image, at roughly 1,500-3,000 input tokens. Twenty pages is
 * already 30-60k tokens on a document nobody has yet decided is useful, and
 * supporting material for a proposal is a brief or a spec — if a 40-page scan
 * turns up, the right answer is for a person to say which pages matter.
 */
export const MAX_OCR_PAGES = 20;

/** Anthropic accepts 32 MB per request; base64 inflates by 4/3. */
const MAX_OCR_BYTES = 20 * 1024 * 1024;

export type OcrResult = {
  ok: boolean;
  text: string;
  costMicroUsd: number;
  /** Set when transcription was refused or failed. Shown to the user. */
  error: string | null;
};

export async function transcribeScannedPdf(args: {
  bytes: Uint8Array;
  filename: string;
  pageCount: number | null;
  correlationId: string;
  proposalId?: string | null;
}): Promise<OcrResult> {
  const pages = args.pageCount ?? 0;

  if (pages > MAX_OCR_PAGES) {
    return {
      ok: false,
      text: "",
      costMicroUsd: 0,
      error: `This scan is ${pages} pages, above the ${MAX_OCR_PAGES}-page limit for reading images. Split it, or put the key points in the intake.`,
    };
  }
  if (args.bytes.byteLength > MAX_OCR_BYTES) {
    return {
      ok: false,
      text: "",
      costMicroUsd: 0,
      error: "This scan is too large to read as images.",
    };
  }

  // Node's base64 encoder, not a hand-rolled one: the string must carry no
  // newlines, and Buffer's output does not.
  const data = Buffer.from(args.bytes).toString("base64");

  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    },
    {
      type: "text",
      text: TRANSCRIBE_INSTRUCTION,
    },
  ];

  try {
    const result = await callClaude({
      purpose: "ocr",
      correlationId: args.correlationId,
      proposalId: args.proposalId ?? null,
      system: [{ type: "text", text: SYSTEM }],
      messages: [{ role: "user", content }],
    });

    const text = result.text.trim();
    if (text.length === 0 || /^\s*NOTHING_LEGIBLE\s*$/i.test(text)) {
      return {
        ok: false,
        text: "",
        costMicroUsd: result.costMicroUsd,
        error:
          "The pages could not be read even as images. They may be blank, too low-resolution, or not a document at all.",
      };
    }

    return { ok: true, text, costMicroUsd: result.costMicroUsd, error: null };
  } catch (err) {
    // Transcription failing must never fail the upload. The source is still
    // recorded as an unreadable scan, which is exactly what it was before this
    // module existed — the attempt is a bonus, not a dependency.
    const app = err instanceof AppError ? err : null;
    return {
      ok: false,
      text: "",
      costMicroUsd: 0,
      error:
        app?.code === ErrorCode.AI_RATE_LIMITED
          ? "Reading the scan was rate-limited. The file was kept, so try re-uploading it shortly."
          : "The scan could not be read automatically. Put the key points in the intake instead.",
    };
  }
}

const SYSTEM =
  "You transcribe scanned business documents. You reproduce what is on the page and nothing else. " +
  "You never infer, complete, correct or tidy a value. An unreadable character is more useful to the " +
  "reader than a plausible guess, because the guess cannot be told apart from a real reading.";

const TRANSCRIBE_INSTRUCTION = [
  "Transcribe this document.",
  "",
  "Rules:",
  "- Reproduce all text in reading order, preserving headings, tables and line items as plain text.",
  "- Copy every figure, date, reference and name EXACTLY as printed. Do not reformat, round, or convert currencies.",
  "- Where a character or number is genuinely illegible, write [illegible] in its place. Never guess a digit.",
  "- Do not summarise, comment, or add anything that is not on the page.",
  "- If the pages carry no legible text at all, reply with exactly: NOTHING_LEGIBLE",
].join("\n");
