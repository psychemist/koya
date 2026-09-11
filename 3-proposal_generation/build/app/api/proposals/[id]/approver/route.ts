import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { assertAccess } from "../../../../../lib/proposal/access";
import { getProposalOrThrow, setAssignedApprover } from "../../../../../lib/proposal/repo";
import { errors } from "../../../../../lib/errors";
import { isEditable } from "../../../../../lib/proposal/state";

type Params = { id: string };

const body = z.object({
  /** A user id, or null to clear the assignment. */
  approverId: z.string().uuid().nullable(),
});

/**
 * Naming who should review this proposal.
 *
 * WHO. `assertAccess(…, "edit")` - the author, or an administrator. Choosing
 * your own reviewer is part of writing the thing, and an approver picking who
 * approves it would be choosing their own replacement.
 *
 * WHEN. Only while the proposal is editable. Once it is with an approver,
 * reassigning underneath them would take a decision away from somebody who
 * may already be halfway through reading it; once it is approved, the
 * question is settled and `approver_id` records the answer.
 *
 * This assigns an INTENTION, never a permission. An assigned approver is
 * still refused if they wrote it, and an approver who was not assigned can
 * still step in, which is what keeps a client from waiting on one person's
 * annual leave.
 */
export const PUT = route<Params>(
  { action: "proposal.approver.assign", roles: ["salesperson", "approver", "admin"] },
  async ({ params, user, request }) => {
    const proposal = await getProposalOrThrow(params.id);
    assertAccess(proposal, user, "edit");

    if (!isEditable(proposal.status)) {
      throw errors.validation(
        proposal.status === "pending_approval"
          ? "This is already with an approver. Withdraw it first if you want somebody else to look at it."
          : `This proposal is ${proposal.status.replace(/_/g, " ")}, so the approver can no longer be changed.`,
      );
    }

    const parsed = body.parse(await readJson(request));
    await setAssignedApprover({
      proposalId: proposal.id,
      approverId: parsed.approverId,
      authorId: proposal.author_id,
    });

    return { proposalId: proposal.id, assignedApproverId: parsed.approverId };
  },
);
