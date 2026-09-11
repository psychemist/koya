import { recordEvent } from "../audit";
import { transcribeScannedPdf } from "../claude/ocr";
import { extractDocument } from "../extract";
import { MAX_SOURCES_PER_PROPOSAL, MAX_UPLOAD_BYTES, formatBytes } from "../limits";
import { sanitiseSourceText } from "../sanitise";
import { gapFingerprint, type GapCandidate } from "./intake";
import { addSource, syncGaps } from "./repo";

/**
 * Turning uploaded files into sources.
 *
 * Lifted verbatim out of the create-proposal action so that attaching a file
 * to an EXISTING proposal takes the identical path. That was the whole reason
 * to extract it: this block decides when a scan is worth paying Claude to
 * transcribe, when an upload has tried to address the model, and how the
 * resulting advisory gaps are reconciled — and a second copy of that on the
 * edit path would have drifted from this one on the first change to either.
 *
 * The reconciliation rule is the subtle part and it survives the move intact.
 * `syncGaps` closes every open gap from the same detector that is NOT in the
 * candidate list it is handed, so the candidates must be the complete set for
 * that detector. See the comment inside the loop.
 *
 * Nothing here throws for a bad file. One unreadable attachment records its
 * own failure and the rest carry on, because losing a whole submission (or a
 * whole edit) to one corrupt PDF is a worse outcome than a source row that
 * says it could not be read.
 */
export async function ingestSources(args: {
  proposalId: string;
  actorId: string;
  correlationId: string;
  files: readonly File[];
}): Promise<{ ingested: number; flagged: number }> {
  const files = args.files.filter((f) => f.size > 0);

  const scannerGaps: GapCandidate[] = [];

  for (const file of files.slice(0, MAX_SOURCES_PER_PROPOSAL)) {
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        await addSource({
          proposalId: args.proposalId,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          byteSize: file.size,
          // Not read, so there are no bytes to hash. The filename plus the
          // size is enough to keep the unique index happy and to show the
          // reviewer which file was rejected.
          sha256: `oversize:${file.name}:${file.size}`,
          pageCount: null,
          extractedText: "",
          extractStatus: "unsupported",
          extractError: `${formatBytes(file.size)} exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit, so it was not read.`,
        });
        continue;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await extractDocument({
        bytes,
        filename: file.name,
        declaredMime: file.type || "application/octet-stream",
      });

      /**
       * A scan gets one more chance, from the model's vision.
       *
       * `status === "empty"` on a PDF means the file parsed but carried no
       * text layer — the classic scanned or photographed document. Rather
       * than record it as unusable, the pages are sent to Claude as images
       * and transcribed. See lib/claude/ocr.ts for why this is a paid,
       * page-capped, advisory-gap-raising path rather than a silent one.
       *
       * Only on `empty`, and only for PDFs. A file that failed to parse is
       * broken, not scanned, and spending tokens on it would be spending
       * them on nothing.
       */
      let text = result.text;
      let status = result.status;
      let extractError = result.error;
      let transcribed = false;

      if (result.status === "empty" && result.detectedMime === "application/pdf") {
        const ocr = await transcribeScannedPdf({
          bytes,
          filename: file.name,
          pageCount: result.pageCount,
          correlationId: args.correlationId,
          proposalId: args.proposalId,
        });

        await recordEvent({
          correlationId: args.correlationId,
          action: "proposal.source_ocr",
          outcome: ocr.ok ? "ok" : "error",
          actorId: args.actorId,
          proposalId: args.proposalId,
          detail: {
            filename: file.name,
            pages: result.pageCount,
            costMicroUsd: ocr.costMicroUsd,
            error: ocr.error,
          },
        });

        if (ocr.ok) {
          // The transcript is untrusted text like any other upload, so it
          // goes through the same scan before it can reach a prompt.
          const clean = sanitiseSourceText(ocr.text);
          text = clean.text;
          status = "ok";
          transcribed = true;
          extractError = `No text layer. Claude read the ${result.pageCount ?? "?"} page(s) as images, so check the figures against the original.`;
        } else {
          extractError = `${result.error ?? "No text layer."} ${ocr.error ?? ""}`.trim();
        }
      }

      await addSource({
        proposalId: args.proposalId,
        filename: file.name,
        mime: result.detectedMime,
        byteSize: result.byteSize,
        sha256: result.sha256,
        pageCount: result.pageCount,
        extractedText: text,
        extractStatus: status,
        extractError,
      });

      /**
       * A transcription is a reading, not a document. The reviewer is told
       * so, because the grounding gate cannot tell the difference: OCR
       * output becomes a source, so a misread figure is not caught by the
       * gate but confirmed by it.
       */
      if (transcribed) {
        const message = `"${file.name}" had no text layer, so it was read from the page images. Check every figure and date against the original before approving. A misreading here would pass the grounding check rather than fail it.`;
        scannerGaps.push({
          sectionKey: null,
          field: null,
          severity: "advisory" as const,
          detectedBy: "scanner" as const,
          message,
          fingerprint: gapFingerprint({ sectionKey: null, field: null, message }),
        });
      }

      /**
       * A file that tried to talk to the model becomes something a human
       * has to look at.
       *
       * Collected here and synced once AFTER the loop, never inside it.
       * `syncGaps` reconciles: it closes every open gap from the same
       * detector that is not in the candidate list it is handed. Calling
       * it per-file would mean the second flagged upload silently resolved
       * the first one's gap. The complete set has to be complete.
       *
       * Advisory, never blocking. Anyone who can attach a file could
       * otherwise stop a proposal from being approved, and a legitimate
       * document - a security policy that happens to discuss prompt
       * injection - will trip the scan honestly. The point is only that
       * the attempt is not silent.
       */
      if (result.sanitised) {
        const { invisiblesRemoved, suspiciousPhrases } = result.sanitised;
        const parts: string[] = [];
        if (invisiblesRemoved > 0) {
          parts.push(
            `${invisiblesRemoved} invisible character${invisiblesRemoved === 1 ? "" : "s"} were removed`,
          );
        }
        if (suspiciousPhrases.length > 0) {
          parts.push(`it contains text addressed to the AI ("${suspiciousPhrases[0]}")`);
        }
        const message = `"${file.name}" was flagged when it was read: ${parts.join(", and ")}. The document was still used. Check that it is what you expect before approving.`;
        scannerGaps.push({
          sectionKey: null,
          field: null,
          severity: "advisory" as const,
          detectedBy: "scanner" as const,
          message,
          fingerprint: gapFingerprint({ sectionKey: null, field: null, message }),
        });
      }
    } catch (err) {
      // One unreadable attachment must not cost the whole submission.
      await recordEvent({
        correlationId: args.correlationId,
        action: "proposal.source_upload",
        outcome: "error",
        actorId: args.actorId,
        proposalId: args.proposalId,
        errorCode: "EXTRACTION_FAILED",
        detail: {
          filename: file.name,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // One reconciliation for the whole batch. See the note above the
  // accumulator for why this cannot happen inside the loop.
  if (scannerGaps.length > 0) {
    await syncGaps({
      proposalId: args.proposalId,
      detectedBy: "scanner",
      candidates: scannerGaps,
    });
  }


  return { ingested: files.length, flagged: scannerGaps.length };
}
