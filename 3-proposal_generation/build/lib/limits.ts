/**
 * Upload limits and accepted types. No imports, by design.
 *
 * These constants are needed in two places with incompatible constraints: the
 * server, where extraction runs and enforces them, and the browser, where the
 * intake form shows them and pre-screens a file before wasting an upload.
 *
 * They used to live in lib/extract.ts. That module imports `node:crypto`,
 * `unpdf` and `mammoth`, so a client component reading one number from it
 * dragged a PDF parser into the browser bundle — which fails the build
 * outright on the `node:` import.
 *
 * The general rule this is the third instance of: ANYTHING A CLIENT COMPONENT
 * IMPORTS MUST STAND ON ITS OWN. See also lib/hash.ts (pure hashing, so the
 * intake validator can run in the browser) and lib/proposal/status.ts (status
 * labels, so badges do not pull in the state machine).
 */

/** 8 MB. Comfortably above a real proposal brief, well below the platform cap. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Beyond this, an upload is a document dump rather than supporting material. */
export const MAX_PDF_PAGES = 60;

/** Extraction is capped so one enormous file cannot dominate the prompt. */
export const MAX_EXTRACTED_CHARS = 60_000;

/** How many attachments one proposal will accept. */
export const MAX_SOURCES_PER_PROPOSAL = 6;

/**
 * Below this many characters of real content per page, a PDF is treated as a
 * scan rather than a document.
 */
export const MIN_CHARS_PER_PAGE = 120;

/** The `accept` attribute for the upload control, and the server's allow-list. */
export const ACCEPTED_UPLOAD_TYPES = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
