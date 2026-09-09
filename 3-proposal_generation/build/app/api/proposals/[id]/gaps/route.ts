import { route } from "../../../../../lib/api";
import { getGaps, getProposalOrThrow } from "../../../../../lib/proposal/repo";
import { assertAccess } from "../../../../../lib/proposal/access";

type Params = { id: string };

/** The current gap list, for the workspace to refresh after an action. */
export const GET = route<Params>({ action: "gap.list" }, async ({ params, user }) => {
  assertAccess(await getProposalOrThrow(params.id), user, "view");
  const gaps = await getGaps(params.id);
  return {
    proposalId: params.id,
    gaps: gaps.map((g) => ({
      id: g.id,
      sectionKey: g.section_key,
      field: g.field,
      severity: g.severity,
      message: g.message,
      detectedBy: g.detected_by,
      status: g.status,
      waiverReason: g.waiver_reason,
    })),
  };
});
