import { route } from "../../../../../lib/api";
import { errors } from "../../../../../lib/errors";
import { getProposalOrThrow, getSources } from "../../../../../lib/proposal/repo";
import { assertAccess } from "../../../../../lib/proposal/access";
import { ingestSources } from "../../../../../lib/proposal/ingest";
import { isEditable } from "../../../../../lib/proposal/state";
import { MAX_SOURCES_PER_PROPOSAL } from "../../../../../lib/limits";

type Params = { id: string };

/**
 * Attaching supporting material to a proposal that already exists.
 *
 * Uploads used to be possible only on the intake form, which meant the one
 * moment a salesperson could attach a document was before they had read the
 * draft — and reading the draft is exactly when you notice that the scope
 * section needs the statement of work you were sent afterwards. The only
 * route was to abandon the proposal and start again.
 *
 * WHO. `assertAccess(…, "edit")` — the author or an administrator, never an
 * approver. An approver who adds material to the document they are judging is
 * no longer independent of it, which is the same reasoning that keeps them
 * out of the section editor.
 *
 * WHEN. `isEditable` — draft, review, changes_requested. A proposal sitting
 * with an approver, or already approved, must not gain a new source: the
 * generated prose cites its sources by index, and adding one underneath an
 * approval would change what the citations refer to after somebody signed it
 * off. A reviewer asking for new material sends it back first.
 *
 * The ingestion itself is the same function the intake form calls, so a file
 * attached here gets the identical treatment: extraction, the OCR fallback
 * for a scan with no text layer, the prompt-injection scan, and the advisory
 * gaps that come out of both.
 */
export const POST = route<Params>(
  { action: "proposal.source_upload" },
  async ({ params, user, request, correlationId }) => {
    const proposal = await getProposalOrThrow(params.id);
    assertAccess(proposal, user, "edit");

    if (!isEditable(proposal.status)) {
      throw errors.validation(
        proposal.status === "pending_approval"
          ? "This proposal is with an approver, so material cannot be added to it. Withdraw it first."
          : `This proposal is ${proposal.status.replace(/_/g, " ")}, so material cannot be added to it.`,
      );
    }

    const form = await request.formData();
    const files = form.getAll("sources").filter((f): f is File => f instanceof File && f.size > 0);

    if (files.length === 0) {
      throw errors.validation("No file was attached.");
    }

    /**
     * The ceiling counts what is already there.
     *
     * `ingestSources` caps each batch, which was enough when a proposal could
     * only ever receive one batch. Now that material can be added repeatedly,
     * the cap has to be on the total or it is not a cap at all.
     */
    const existing = await getSources(proposal.id);
    const room = MAX_SOURCES_PER_PROPOSAL - existing.length;
    if (room <= 0) {
      throw errors.validation(
        `This proposal already has the maximum of ${MAX_SOURCES_PER_PROPOSAL} attachments. Remove one before adding another.`,
      );
    }

    const accepted = files.slice(0, room);
    const result = await ingestSources({
      proposalId: proposal.id,
      actorId: user.id,
      correlationId,
      files: accepted,
    });

    const sources = await getSources(proposal.id);

    return {
      proposalId: proposal.id,
      ingested: result.ingested,
      flagged: result.flagged,
      /** Files handed over but refused for want of room, so the UI can say so. */
      rejected: files.length - accepted.length,
      sources: sources.map((s) => ({
        id: s.id,
        filename: s.filename,
        status: s.extract_status,
        error: s.extract_error,
        byteSize: s.byte_size,
        pageCount: s.page_count,
      })),
    };
  },
);
