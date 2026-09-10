import { fileResponse, rawRoute } from "../../../../../lib/api";
import { AppError, ErrorCode, errors } from "../../../../../lib/errors";
import { buildDocumentModel, renderMarkdown } from "../../../../../lib/docgen/markdown";
import { buildProposalPdf, renderPlainText } from "../../../../../lib/docgen/pdf";
import { buildProposalDocx } from "../../../../../lib/docgen/docx";
import { getSections, getProposalOrThrow } from "../../../../../lib/proposal/repo";
import { assertAccess } from "../../../../../lib/proposal/access";

type Params = { id: string };

/**
 * The proposal as a file.
 *
 * Generated on demand from the stored sections rather than saved as a blob at
 * approval time. Two reasons:
 *
 *   There is no stale artefact. A PDF written at approval and a proposal edited
 *   afterwards would disagree, and the file is the thing the client keeps.
 *
 *   There is nothing to store, back up, or clean up. Rendering is
 *   deterministic and takes tens of milliseconds, so regenerating costs less
 *   than managing object storage would.
 *
 * `internal=1` keeps the `[NEEDS INPUT: ...]` markers in, for a salesperson who
 * wants to circulate a draft inside the firm. Everything else is built with
 * `forClient: true`, which strips them.
 */
export const GET = rawRoute<Params>(
  { action: "proposal.document" },
  async ({ params, request, user }) => {
    const url = new URL(request.url);
    const format = (url.searchParams.get("format") ?? "pdf").toLowerCase();
    const internal = url.searchParams.get("internal") === "1";

    const proposal = await getProposalOrThrow(params.id);
    assertAccess(proposal, user, "view");
    const sections = await getSections(proposal.id);

    if (sections.every((s) => s.body_md.trim().length === 0)) {
      throw errors.validation(
        "This proposal has not been written yet, so there is nothing to download.",
      );
    }

    const model = buildDocumentModel({
      ref: proposal.ref,
      intake: proposal.intake,
      sections: sections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
      forClient: !internal,
    });

    const base = `${proposal.ref}-${slug(proposal.intake.company_name)}`;

    try {
      if (format === "pdf") {
        return fileResponse({
          bytes: await buildProposalPdf(model),
          filename: `${base}.pdf`,
          mime: "application/pdf",
        });
      }

      if (format === "docx") {
        return fileResponse({
          bytes: await buildProposalDocx(model),
          filename: `${base}.docx`,
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      }

      if (format === "md") {
        return fileResponse({
          bytes: new TextEncoder().encode(renderMarkdown(model)),
          filename: `${base}.md`,
          mime: "text/markdown; charset=utf-8",
        });
      }

      if (format === "txt") {
        return fileResponse({
          bytes: new TextEncoder().encode(renderPlainText(model)),
          filename: `${base}.txt`,
          mime: "text/plain; charset=utf-8",
        });
      }
    } catch (err) {
      // Document generation is the step most likely to fail on odd content, so
      // it gets its own error code rather than being reported as INTERNAL.
      throw new AppError({
        code: ErrorCode.DOCGEN_FAILED,
        userMessage: `The ${format.toUpperCase()} could not be generated. The proposal itself is untouched, so try another format, or quote the reference below.`,
        message: err instanceof Error ? err.message : String(err),
        detail: { format, ref: proposal.ref },
        cause: err,
      });
    }

    throw errors.validation(
      `"${format}" is not a format this endpoint produces. Use pdf, docx, md or txt.`,
    );
  },
);

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "proposal"
  );
}
