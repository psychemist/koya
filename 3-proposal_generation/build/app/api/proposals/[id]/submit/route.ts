import { route } from "../../../../../lib/api";
import { submitForApproval } from "../../../../../lib/proposal/service";

type Params = { id: string };

/**
 * Hands the proposal to an approver.
 *
 * Refuses while any section is still empty. Submitting an unfinished document
 * wastes the approver's attention and teaches them to skim, which is the
 * failure mode that makes an approval step worthless.
 *
 * Blocking gaps deliberately do NOT prevent submission — they prevent
 * approval. An approver often is the right person to judge whether a gap
 * should be waived, so making them look at it is the point.
 */
export const POST = route<Params>(
  { action: "proposal.submit", roles: ["salesperson", "approver"] },
  async ({ params, user, correlationId }) => {
    const proposal = await submitForApproval({
      proposalId: params.id,
      actor: user,
      correlationId,
    });
    return {
      proposalId: proposal.id,
      status: proposal.status,
      version: proposal.version,
    };
  },
);
