import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { decideApproval } from "../../../../../lib/proposal/service";

type Params = { id: string };

const body = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  note: z.string().trim().max(2000).optional(),
});

/**
 * The approval decision.
 *
 * Restricted to the approver role at the route boundary, and checked again in
 * `decideApproval` against the state machine — which also refuses when the
 * actor is the author, whatever role they hold, and when a blocking gap is
 * still open. Three independent checks, because this is the control the whole
 * system exists to enforce.
 */
export const POST = route<Params>(
  { action: "proposal.approve", roles: ["approver"] },
  async ({ params, request, user, correlationId }) => {
    const parsed = body.parse(await readJson(request));
    const proposal = await decideApproval({
      proposalId: params.id,
      actor: user,
      decision: parsed.decision,
      note: parsed.note ?? null,
      correlationId,
    });
    return {
      proposalId: proposal.id,
      status: proposal.status,
      version: proposal.version,
      decision: parsed.decision,
    };
  },
);
