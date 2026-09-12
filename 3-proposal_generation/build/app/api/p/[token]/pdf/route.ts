import { countOpenBlockingGaps, getProposalOrThrow, getSections } from "../../../../../lib/proposal/repo";
import { resolveShareToken } from "../../../../../lib/proposal/share";
import { buildDocumentModel } from "../../../../../lib/docgen/markdown";
import { buildProposalPdf } from "../../../../../lib/docgen/pdf";
import { recordEvent } from "../../../../../lib/audit";
import { newCorrelationId } from "../../../../../lib/errors";
import { sanitiseFilename } from "../../../../../lib/api";

/**
 * The client's own PDF download, authenticated by the share token only.
 *
 * Separate from the internal /api/proposals/[id]/document route on purpose:
 * this one takes no session, cannot be given `internal=1`, and re-checks the
 * blocking-gap gate before it renders. Reusing the internal route with an
 * unauthenticated bypass would have made one endpoint responsible for two
 * different trust levels, which is how a bypass ends up applying to both.
 */
export async function GET(
  _request: Request,
  segment: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = newCorrelationId();
  const { token } = await segment.params;

  const resolved = await resolveShareToken(token);
  if (!resolved) {
    await recordEvent({
      correlationId,
      action: "public.proposal_pdf",
      outcome: "denied",
      detail: { reason: "unresolvable_token" },
    });
    return new Response("Not found", { status: 404 });
  }

  const proposal = await getProposalOrThrow(resolved.proposalId);
  const blocking = await countOpenBlockingGaps(proposal.id);
  if (blocking > 0) {
    await recordEvent({
      correlationId,
      action: "public.proposal_pdf",
      outcome: "error",
      proposalId: proposal.id,
      errorCode: "BLOCKING_GAPS_OPEN",
      detail: { blocking },
    });
    return new Response("Not found", { status: 404 });
  }

  const sections = await getSections(proposal.id);
  const model = buildDocumentModel({
    ref: proposal.ref,
    intake: proposal.intake,
    sections: sections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    forClient: true,
  });

  try {
    const bytes = await buildProposalPdf(model);
    await recordEvent({
      correlationId,
      action: "public.proposal_pdf",
      outcome: "ok",
      proposalId: proposal.id,
      detail: { ref: proposal.ref, bytes: bytes.byteLength },
    });

    /**
     * `attachment`, not `inline`, and the reason is the CSP.
     *
     * This was `inline`, on the reasoning that a client clicking a link in an
     * email expects the document to open rather than land in Downloads. That
     * reasoning is sound and the header still did not work, because Chrome
     * renders an inline PDF in its built-in viewer, that viewer is an embedded
     * plugin, and this response carries the application's own CSP (the header
     * rule matches every path, `/api/*` included) which says `object-src
     * 'none'` and `frame-src 'none'`. So the browser was told to display a PDF
     * in a plugin and forbidden from loading plugins by the same response. The
     * button did nothing at all, silently, with no console error the client
     * would ever see.
     *
     * Two ways out, and this is the better one. Relaxing `object-src` for this
     * route would weaken a real policy to fix a presentation detail, which is
     * the exact move the comment above the CSP warns against. Downloading the
     * file needs no plugin, cannot be blocked, and matches what the button has
     * always said: Download PDF.
     *
     * The internal document route has always used `attachment`, which is why
     * that download worked and this one did not.
     */
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${sanitiseFilename(`${proposal.ref}-proposal.pdf`)}"`,
        "Cache-Control": "no-store",
        "X-Correlation-Id": correlationId,
      },
    });
  } catch (err) {
    await recordEvent({
      correlationId,
      action: "public.proposal_pdf",
      outcome: "error",
      proposalId: proposal.id,
      errorCode: "DOCGEN_FAILED",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    return new Response("The document could not be generated.", { status: 500 });
  }
}
