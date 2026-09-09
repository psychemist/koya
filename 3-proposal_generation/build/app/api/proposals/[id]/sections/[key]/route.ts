import { z } from "zod";
import { readJson, route } from "../../../../../../lib/api";
import { errors } from "../../../../../../lib/errors";
import { isSectionKey } from "../../../../../../lib/proposal/sections";
import {
  editSection,
  regenerateSection,
  revertSection,
} from "../../../../../../lib/proposal/service";
import { getProposalOrThrow, getSectionHistory } from "../../../../../../lib/proposal/repo";
import { formatUsd } from "../../../../../../lib/claude/models";
import { LIMITS, enforce } from "../../../../../../lib/ratelimit";
import { assertAccess } from "../../../../../../lib/proposal/access";

/**
 * One section, four operations.
 *
 * This route is the PRD's fourth test scenario made concrete: every operation
 * here addresses a single section by key and touches exactly one row, so
 * revising the pricing section cannot disturb the introduction. The previous
 * text is appended to `section_versions` first, which is what makes every
 * change reversible.
 */

type Params = { id: string; key: string };

const regenerateBody = z.object({
  instruction: z.string().trim().max(2000).optional(),
});

const editBody = z.object({
  body_md: z.string().max(20_000),
});

const revertBody = z.object({
  version: z.number().int().positive(),
});

function sectionKeyOf(params: Params) {
  if (!isSectionKey(params.key)) {
    throw errors.notFound(`Section "${params.key}"`);
  }
  return params.key;
}

/** Regenerate with Claude, optionally following the salesperson's instruction. */
export const POST = route<Params>(
  { action: "section.regenerate", roles: ["salesperson", "approver"] },
  async ({ params, request, user, correlationId }) => {
    const key = sectionKeyOf(params);
    const body = regenerateBody.parse(await readJson(request));
    // The other paid call. Looser than the full-draft ceiling because
    // iterating on one section is the intended workflow, not an anomaly.
    await enforce(LIMITS.regenerate, user.id, "You have regenerated a lot of sections in the last hour.");

    const result = await regenerateSection({
      proposalId: params.id,
      key,
      instruction: body.instruction ?? null,
      actor: user,
      correlationId,
    });

    return {
      proposalId: params.id,
      key,
      body: result.body,
      costMicroUsd: result.costMicroUsd,
      costLabel: formatUsd(result.costMicroUsd),
      gaps: { blocking: result.blocking, advisory: result.advisory },
    };
  },
);

/** Save a hand-written edit. No model call, so no cost. */
export const PATCH = route<Params>(
  { action: "section.edit", roles: ["salesperson", "approver"] },
  async ({ params, request, user, correlationId }) => {
    const key = sectionKeyOf(params);
    const body = editBody.parse(await readJson(request));

    const gaps = await editSection({
      proposalId: params.id,
      key,
      bodyMd: body.body_md,
      actor: user,
      correlationId,
    });

    return { proposalId: params.id, key, gaps };
  },
);

/** Restore an earlier version. */
export const PUT = route<Params>(
  { action: "section.revert", roles: ["salesperson", "approver"] },
  async ({ params, request, user }) => {
    const key = sectionKeyOf(params);
    const body = revertBody.parse(await readJson(request));

    const restored = await revertSection({
      proposalId: params.id,
      key,
      version: body.version,
      actor: user,
    });

    return { proposalId: params.id, key, body: restored };
  },
);

/** The version history for the inspector panel. */
export const GET = route<Params>(
  { action: "section.history" },
  async ({ params, user }) => {
    assertAccess(await getProposalOrThrow(params.id), user, "view");
    const key = sectionKeyOf(params);
    const history = await getSectionHistory(params.id, key);
    return {
      proposalId: params.id,
      key,
      history: history.map((h) => ({
        version: h.version,
        origin: h.origin,
        instruction: h.instruction,
        actorName: h.actor_name,
        createdAt: h.created_at,
        // The body is included so the inspector can preview and diff without a
        // second round trip per version.
        body: h.body_md,
      })),
    };
  },
);
