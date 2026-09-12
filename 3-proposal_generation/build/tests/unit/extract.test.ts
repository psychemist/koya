import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocument } from "../../lib/extract";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = join(here, "..", "..", "..", "test-pack", "03-supporting-material", "files");
const SCAN = join(FILES, "scanned-invoice-no-text-layer.pdf");

/**
 * Extraction must not destroy the bytes it was given.
 *
 * WHY THIS TEST EXISTS. `unpdf`'s `getDocumentProxy` TRANSFERS the underlying
 * ArrayBuffer, which detaches the caller's `Uint8Array`: after extraction the
 * array the caller still holds has `byteLength === 0`. Nothing in the
 * signature suggests it, and nothing throws when it happens.
 *
 * It broke the OCR fallback completely, and silently, for the entire life of
 * the feature. `ingestSources` extracts a PDF, sees `status: "empty"`, and
 * passes the same array to `transcribeScannedPdf` to be read as images. By
 * then it was empty, so every scan was sent to Claude as a zero-byte document,
 * the call failed, and the catch reported "the scan could not be read
 * automatically" - indistinguishable from a genuinely unreadable scan. The
 * feature had never once worked through the real upload path, and the error
 * message was the exact one a working implementation would produce on a bad
 * file.
 *
 * The assertion is on the buffer rather than on the transcription, so it costs
 * nothing and runs in CI. The transcription itself needs a live model call and
 * is exercised by `npm run sample` and by the manual pack.
 */

const havePdf = existsSync(SCAN);

test("extraction leaves the caller's bytes intact", { skip: !havePdf }, async () => {
  const bytes = new Uint8Array(readFileSync(SCAN));
  const before = bytes.byteLength;
  assert.ok(before > 0, "fixture should not be empty");

  const result = await extractDocument({
    bytes,
    filename: "scanned-invoice-no-text-layer.pdf",
    declaredMime: "application/pdf",
  });

  // The scan itself: no text layer, so extraction reports empty rather than ok.
  assert.equal(result.status, "empty");

  // The point of the test. Without the defensive copy in extract.ts this is 0,
  // and the OCR fallback downstream silently receives nothing.
  assert.equal(
    bytes.byteLength,
    before,
    "extractDocument detached the caller's buffer; the OCR fallback will receive an empty PDF",
  );
  assert.ok(Buffer.from(bytes).toString("base64").length > 0, "the bytes are still encodable");
});

test("a second extraction of the same array still works", { skip: !havePdf }, async () => {
  // The consequence of detachment that a single call cannot show: the array is
  // reusable, so any caller may read it again afterwards.
  const bytes = new Uint8Array(readFileSync(SCAN));
  const first = await extractDocument({ bytes, filename: "a.pdf", declaredMime: "application/pdf" });
  const second = await extractDocument({ bytes, filename: "a.pdf", declaredMime: "application/pdf" });
  assert.equal(first.status, second.status);
  assert.equal(first.sha256, second.sha256);
});
