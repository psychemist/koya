import { route } from "../../../../../lib/api";
import { withdrawSubmission } from "../../../../../lib/proposal/service";

/**
 * Take a submission back before anyone has decided on it.
 *
 * The counterpart to submit, and it exists because without it
 * `pending_approval` is a one-way door: only an approver can move a proposal
 * out of it, and an approver cannot approve one with a blocking gap open. An
 * author who submits early would otherwise be stuck.
 */
export const POST = route<{ id: string }>(
  { action: "proposal.withdraw", roles: ["salesperson", "approver", "admin"] },
  async ({ params, user, correlationId }) => {
    const proposal = await withdrawSubmission({
      proposalId: params.id,
      actor: user,
      correlationId,
    });
    return { proposalId: proposal.id, status: proposal.status };
  },
);
