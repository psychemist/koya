# 03 · Supporting material used

**Claimed:** uploaded material informs the draft and is cited.

**Status in the evidence table: ⚠️ Partial.** The plumbing passes. The one link still
unexercised is *citation of an upload inside generated prose* — which is precisely
what the steps below are for, so run them and close it.

## Files

Four real PDFs from the Week 1 test pack, chosen because they behave differently:

| File | Text layer | What it exercises |
|---|---|---|
| [`files/meridian-INV-4471.pdf`](files/meridian-INV-4471.pdf) | **Yes**, 664 characters | The ordinary path. Extraction, no OCR. |
| [`files/harcourt-HFM-2026-0815.pdf`](files/harcourt-HFM-2026-0815.pdf) | Yes | A second source, for the dedup and multi-source checks. |
| [`files/scanned-invoice-no-text-layer.pdf`](files/scanned-invoice-no-text-layer.pdf) | **No**, 0 characters | The OCR fallback. This used to be a dead end. |
| [`files/oakridge-scan-damaged.pdf`](files/oakridge-scan-damaged.pdf) | Partial / damaged | The degraded case. It must fail *legibly*. |

## Steps

1. Start from row 01's complete intake, but before generating, attach
   `meridian-INV-4471.pdf` and `harcourt-HFM-2026-0815.pdf`.
2. Attach `meridian-INV-4471.pdf` **a second time**.
3. Generate. Read the Proposed Solution and Scope sections for citation markers.
4. New proposal. Attach `scanned-invoice-no-text-layer.pdf`. Generate.
5. New proposal. Attach `oakridge-scan-damaged.pdf`. Generate.

## Expected

| Step | What should happen |
|---|---|
| 2 | **One source, not two.** The same bytes are content-hash deduped. The second upload does not create a second row and does not cost a second extraction. |
| 3 | The draft draws on the attachments. Citation markers are parsed and **stripped from the client output** while surviving in the internal view. |
| 4 | 0 characters extracted → the **OCR fallback fires**. Claude transcribes it from the PDF itself by vision — no OCR library. Capped at 20 pages. An **advisory gap** appears telling the reviewer to check the figures against the original. |
| 5 | It does not crash and it does not pretend. Whatever it could read, it used; whatever it could not is reported, not guessed. |

## Why step 4 raises a gap rather than passing silently

A misread figure from a scan would be **confirmed** by the grounding gate rather than
caught by it. The gate checks that every number in the prose traces back to a source;
if the source itself is a bad transcription, the number traces perfectly and is still
wrong. The advisory gap is the only thing standing between that and a client.

## Where the assertion lives

- `build/lib/claude/ocr.ts` — the vision fallback
- `build/lib/extract.ts` — extraction and the 0-character branch
- `build/tests/unit/parse.test.ts` — citation parsing and stripping
- `build/scripts/e2e.ts` — content-hash dedup against real Postgres
- `build/db/migrations/005_ocr_purpose.sql` — OCR recorded as its own call purpose, so it shows up separately on the System page's spend table
