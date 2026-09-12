import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { sha256Hex } from "./crypto";
import { AppError, ErrorCode } from "./errors";
import { sanitiseSourceText } from "./sanitise";
import {
  MAX_EXTRACTED_CHARS,
  MAX_PDF_PAGES,
  MAX_UPLOAD_BYTES,
  MIN_CHARS_PER_PAGE,
} from "./limits";

// Re-exported so server-side callers can keep importing them from here.
export { MAX_EXTRACTED_CHARS, MAX_PDF_PAGES, MAX_UPLOAD_BYTES } from "./limits";

/**
 * Turning an uploaded file into text Claude can read.
 *
 * The supporting-material feature is only as good as this layer, and the
 * failure that matters is not a crash — it is a file that extracts to nothing
 * and is then silently treated as though it contributed context. A scanned PDF
 * with no text layer is the classic case: it opens fine, it has pages, and it
 * yields zero characters. So "empty" is a first-class outcome here with its
 * own message, not an error and not a success.
 */


export type ExtractStatus = "ok" | "empty" | "unsupported" | "failed";

export type ExtractResult = {
  text: string;
  pageCount: number | null;
  status: ExtractStatus;
  error: string | null;
  sha256: string;
  byteSize: number;
  /** The type we actually detected, which may differ from what was declared. */
  detectedMime: string;
  truncated: boolean;
  /**
   * What the injection scan found in this file, if anything. Non-null only
   * when something was found, so a caller can test the field itself.
   */
  sanitised: {
    invisiblesRemoved: number;
    suspiciousPhrases: string[];
  } | null;
};

type Kind = "pdf" | "docx" | "text" | "unknown";

/**
 * Detects the type from the file's own bytes, not its name or its declared
 * Content-Type.
 *
 * Both of those are supplied by the client and neither is trustworthy: a
 * .docx renamed to .pdf would otherwise be handed to the PDF parser, which
 * fails with a confusing low-level error rather than "this is not a PDF".
 */
function sniff(bytes: Uint8Array, filename: string, declaredMime: string): Kind {
  // %PDF
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf";
  }
  // PK zip header — docx is a zip. Distinguish by extension, since xlsx and
  // pptx share the header and neither is useful as proposal context.
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return /\.docx$/i.test(filename) ? "docx" : "unknown";
  }

  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && ["txt", "md", "markdown", "csv", "tsv", "json", "rtf"].includes(ext)) return "text";
  if (declaredMime.startsWith("text/")) return "text";

  // Heuristic last resort: if it decodes as UTF-8 without replacement
  // characters in the first kilobyte, treat it as text.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 1024));
  if (head.length > 0 && !head.includes("�")) return "text";

  return "unknown";
}


/**
 * Strips the furniture a browser adds when someone "prints" a web page to PDF:
 * a timestamp line, the source URL, and a "1/2" page counter.
 *
 * This exists because of a real case. A PDF that is a photograph of an invoice
 * still extracts a couple of hundred characters — the print header and the
 * image's own URL — so a naive "did we get any text?" check says yes and the
 * file is treated as usable context when it contains none. Measuring content
 * *after* removing the furniture is what makes the scan detectable.
 */
function stripPrintFurniture(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const l = line.trim();
      if (l.length === 0) return false;
      if (/^https?:\/\/\S+$/i.test(l)) return false; // bare source URL
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*(am|pm)?/i.test(l)) return false;
      if (/^\d+\s*\/\s*\d+$/.test(l)) return false; // page counter
      if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(l)) return false;
      return true;
    })
    .join("\n");
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // Collapse the runs of spaces PDF extraction leaves between glyph groups.
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractDocumentRaw(args: {
  bytes: Uint8Array;
  filename: string;
  declaredMime: string;
}): Promise<Omit<ExtractResult, "sanitised">> {
  const { bytes, filename, declaredMime } = args;
  const byteSize = bytes.byteLength;
  const sha256 = sha256Hex(Buffer.from(bytes));

  if (byteSize === 0) {
    return {
      text: "",
      pageCount: null,
      status: "failed",
      error: "The file is empty (0 bytes). It may not have finished uploading.",
      sha256,
      byteSize,
      detectedMime: declaredMime || "application/octet-stream",
      truncated: false,
    };
  }

  if (byteSize > MAX_UPLOAD_BYTES) {
    throw new AppError({
      code: ErrorCode.FILE_TOO_LARGE,
      userMessage: `"${filename}" is ${(byteSize / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, so attach the relevant pages rather than the whole document.`,
      detail: { filename, byteSize },
    });
  }

  const kind = sniff(bytes, filename, declaredMime);

  const base = { sha256, byteSize };

  try {
    if (kind === "pdf") {
      /**
       * unpdf gets its OWN copy of the bytes.
       *
       * `getDocumentProxy` transfers the underlying ArrayBuffer, which
       * DETACHES the caller's array: after this line, the `bytes` the caller
       * passed in has `byteLength === 0`. Nothing in the signature says so,
       * and nothing fails at the point it happens.
       *
       * It broke OCR completely and silently. `ingestSources` extracts a PDF,
       * sees `status: "empty"`, and hands the same array to
       * `transcribeScannedPdf` to be read as images - by which time it is an
       * empty buffer. Claude was sent a zero-byte document on every scan, the
       * call failed, and the generic catch reported "the scan could not be
       * read automatically", which is exactly what an unreadable scan looks
       * like. The feature had never once worked through the real upload path.
       *
       * Copied here rather than at the call sites. A function that destroys
       * its argument is a trap for every future caller, and only this line
       * knows the trap exists.
       */
      const doc = await getDocumentProxy(new Uint8Array(bytes));
      const pageCount = doc.numPages;

      if (pageCount > MAX_PDF_PAGES) {
        return {
          ...base,
          text: "",
          pageCount,
          status: "unsupported",
          error: `${pageCount} pages exceeds the ${MAX_PDF_PAGES}-page limit. Attach an extract instead.`,
          detectedMime: "application/pdf",
          truncated: false,
        };
      }

      const result = await extractText(doc, { mergePages: true });
      const raw = normaliseWhitespace(stripPrintFurniture(String(result.text ?? "")));

      // The scanned-document case, in both its forms: no text at all, and the
      // more deceptive one where the only text is page furniture. Named
      // plainly, because the user's next action — run it through OCR, or type
      // the key points into the intake — depends on knowing this rather than
      // assuming the upload worked.
      if (raw.length === 0 || raw.length < pageCount * MIN_CHARS_PER_PAGE) {
        const scanned = raw.length === 0
          ? "This PDF has no text layer"
          : `This PDF yielded only ${raw.length} characters across ${pageCount} page${pageCount === 1 ? "" : "s"}`;
        return {
          ...base,
          text: "",
          pageCount,
          status: "empty",
          // The wording stops short of a verdict on purpose: this status is
          // where the OCR fallback picks the file up, so "nothing usable
          // could be read" was telling the user the opposite of what happens
          // next. Whether it contributes is decided after transcription.
          error: `${scanned}. It is almost certainly a scan or a photograph, so it will be read from the page images instead. Check any figures it contributes against the original.`,
          detectedMime: "application/pdf",
          truncated: false,
        };
      }

      const truncated = raw.length > MAX_EXTRACTED_CHARS;
      return {
        ...base,
        text: truncated ? raw.slice(0, MAX_EXTRACTED_CHARS) : raw,
        pageCount,
        status: "ok",
        error: truncated
          ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters were used.`
          : null,
        detectedMime: "application/pdf",
        truncated,
      };
    }

    if (kind === "docx") {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      const raw = normaliseWhitespace(result.value ?? "");
      if (raw.length === 0) {
        return {
          ...base,
          text: "",
          pageCount: null,
          status: "empty",
          error: "This document contains no readable text.",
          detectedMime:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          truncated: false,
        };
      }
      const truncated = raw.length > MAX_EXTRACTED_CHARS;
      return {
        ...base,
        text: truncated ? raw.slice(0, MAX_EXTRACTED_CHARS) : raw,
        pageCount: null,
        status: "ok",
        error: truncated
          ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters were used.`
          : null,
        detectedMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        truncated,
      };
    }

    if (kind === "text") {
      // `fatal: false` so a stray invalid byte yields a replacement character
      // rather than throwing away an otherwise readable file.
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const raw = normaliseWhitespace(decoded.replace(/�/g, ""));
      if (raw.length === 0) {
        return {
          ...base,
          text: "",
          pageCount: null,
          status: "empty",
          error: "The file contains no readable text.",
          detectedMime: declaredMime || "text/plain",
          truncated: false,
        };
      }
      const truncated = raw.length > MAX_EXTRACTED_CHARS;
      return {
        ...base,
        text: truncated ? raw.slice(0, MAX_EXTRACTED_CHARS) : raw,
        pageCount: null,
        status: "ok",
        error: truncated
          ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters were used.`
          : null,
        detectedMime: declaredMime || "text/plain",
        truncated,
      };
    }

    return {
      ...base,
      text: "",
      pageCount: null,
      status: "unsupported",
      error:
        "Only PDF, Word (.docx) and plain-text files can be read. Convert it, or paste the relevant part into the intake.",
      detectedMime: declaredMime || "application/octet-stream",
      truncated: false,
    };
  } catch (err) {
    // A corrupt or password-protected file lands here. The proposal is not
    // blocked by it: the source is stored with status 'failed' and the reason,
    // and the salesperson decides whether to fix the file or carry on without.
    return {
      ...base,
      text: "",
      pageCount: null,
      status: "failed",
      error: `Could not be read: ${err instanceof Error ? err.message : String(err)}. It may be corrupt or password-protected.`,
      detectedMime: declaredMime || "application/octet-stream",
      truncated: false,
    };
  }
}

/** Human-facing summary of what happened to an upload. */
export function describeExtraction(r: {
  extract_status: ExtractStatus | string;
  page_count: number | null;
  extracted_text: string;
  extract_error: string | null;
}): string {
  switch (r.extract_status) {
    case "ok": {
      const words = r.extracted_text.trim().split(/\s+/).length;
      const pages = r.page_count ? `${r.page_count} page${r.page_count === 1 ? "" : "s"}, ` : "";
      return `${pages}${words.toLocaleString()} words read${r.extract_error ? ` · ${r.extract_error}` : ""}`;
    }
    case "empty":
      return r.extract_error ?? "No text could be read.";
    case "unsupported":
      return r.extract_error ?? "This file type cannot be read.";
    case "failed":
      return r.extract_error ?? "Could not be read.";
    default:
      return "Waiting to be read.";
  }
}

/**
 * Extraction, then sanitisation. The only entry point callers should use.
 *
 * These are separate steps and this wrapper is what guarantees the second one
 * always follows the first. `extractDocumentRaw` returns text at three
 * different points depending on the file type, and sanitising at each of them
 * would mean a fourth branch added later silently skips it. Wrapping is the
 * shape where forgetting is not possible.
 */
export async function extractDocument(
  args: Parameters<typeof extractDocumentRaw>[0],
): Promise<ExtractResult> {
  const result = await extractDocumentRaw(args);
  if (result.text.length === 0) return { ...result, sanitised: null };

  const report = sanitiseSourceText(result.text);
  return {
    ...result,
    text: report.text,
    sanitised: report.flagged
      ? {
          invisiblesRemoved: report.invisiblesRemoved,
          suspiciousPhrases: report.suspiciousPhrases,
        }
      : null,
  };
}
