import { route, readJson } from "../../../../../lib/api";
import { intakeSchema } from "../../../../../lib/proposal/intake";
import { getProposalOrThrow, updateIntake } from "../../../../../lib/proposal/repo";
import { runGapAnalysis } from "../../../../../lib/proposal/service";
import { isEditable } from "../../../../../lib/proposal/state";
import { errors } from "../../../../../lib/errors";
import { assertAccess } from "../../../../../lib/proposal/access";

type Params = { id: string };

/**
 * Edits the intake after creation — the usual way a blocking gap gets
 * resolved, since most of them are a missing field.
 *
 * The version guard in `updateIntake` means two people editing at once
 * produce one winner and one clear "reload, nothing was lost" message rather
 * than a silent overwrite. The cheap validator re-runs immediately so the gap
 * list reflects the edit without waiting for a regeneration.
 */
export const PATCH = route<Params>(
  { action: "proposal.intake_edit", roles: ["salesperson", "approver"] },
  async ({ params, request, correlationId, user }) => {
    const current = await getProposalOrThrow(params.id);
    assertAccess(current, user, "edit");
    if (!isEditable(current.status)) {
      throw errors.invalidTransition(current.status, "review");
    }

    const parsed = intakeSchema.parse(await readJson(request));
    const updated = await updateIntake({
      proposalId: params.id,
      intake: parsed,
      expectedVersion: current.version,
    });

    const gaps = await runGapAnalysis({
      proposal: updated,
      correlationId,
      cheapOnly: true,
    });

    return {
      proposalId: updated.id,
      version: updated.version,
      intake: updated.intake,
      gaps,
      // A changed intake invalidates the generation cache, so the UI can say
      // that a redraft will actually cost something this time.
      contentChanged: updated.intake_hash !== current.intake_hash,
    };
  },
);
