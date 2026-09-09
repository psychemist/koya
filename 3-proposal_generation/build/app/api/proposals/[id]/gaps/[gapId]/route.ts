import { z } from "zod";
import { readJson, route } from "../../../../../../lib/api";
import { errors } from "../../../../../../lib/errors";
import { getProposalOrThrow, reopenGap, resolveGap, waiveGap } from "../../../../../../lib/proposal/repo";
import { gapCounts } from "../../../../../../lib/proposal/service";
import { assertAccess } from "../../../../../../lib/proposal/access";

/**
 * Acting on a gap.
 *
 * Three actions, and the distinction between them is the substance of the
 * missing-information requirement:
 *
 *   resolve — the underlying condition is gone (the field was filled in, the
 *             figure was added). The check will confirm it on the next run,
 *             and if the condition returns the gap reopens by itself.
 *
 *   waive   — the condition stands and a human has decided to proceed anyway.
 *             This requires a written reason, enforced here AND by a CHECK
 *             constraint in the schema, and it survives re-detection. An
 *             unexplained waiver is indistinguishable from clicking through a
 *             warning, which is exactly what the gate exists to prevent.
 *
 *   reopen   — undo a resolution or a waiver.
 */

type Params = { id: string; gapId: string };

const actionBody = z.object({
  action: z.enum(["resolve", "waive", "reopen"]),
  reason: z.string().trim().max(1000).optional(),
});

export const POST = route<Params>(
  { action: "gap.decide", roles: ["salesperson", "approver"] },
  async ({ params, request, user }) => {
    assertAccess(await getProposalOrThrow(params.id), user, "edit");
    const body = actionBody.parse(await readJson(request));

    if (body.action === "resolve") {
      const gap = await resolveGap({
        proposalId: params.id,
        gapId: params.gapId,
        actorId: user.id,
      });
      return {
        proposalId: params.id,
        gap: shape(gap),
        gaps: await gapCounts(params.id),
      };
    }

    if (body.action === "waive") {
      if (!body.reason) {
        throw errors.validation(
          "A waiver needs a written reason. It goes into the audit trail and is what an approver reads to decide whether to accept it.",
        );
      }
      const gap = await waiveGap({
        proposalId: params.id,
        gapId: params.gapId,
        actorId: user.id,
        reason: body.reason,
      });
      return {
        proposalId: params.id,
        gap: shape(gap),
        gaps: await gapCounts(params.id),
      };
    }

    const gap = await reopenGap(params.id, params.gapId);
    return { proposalId: params.id, gap: shape(gap), gaps: await gapCounts(params.id) };
  },
);

function shape(gap: {
  id: string;
  section_key: string | null;
  field: string | null;
  severity: string;
  message: string;
  detected_by: string;
  status: string;
  waiver_reason: string | null;
}) {
  return {
    id: gap.id,
    sectionKey: gap.section_key,
    field: gap.field,
    severity: gap.severity,
    message: gap.message,
    detectedBy: gap.detected_by,
    status: gap.status,
    waiverReason: gap.waiver_reason,
  };
}
