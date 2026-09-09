import { z } from "zod";
import { readJson, route } from "../../../../../../lib/api";
import { assertAccess } from "../../../../../../lib/proposal/access";
import { getProposalOrThrow, setCommentResolved } from "../../../../../../lib/proposal/repo";

type Params = { id: string; commentId: string };

const body = z.object({ resolved: z.boolean() });

/**
 * Resolve or reopen one comment.
 *
 * View rights are enough, deliberately. The author resolves a question once
 * they have answered it; the reviewer who raised it reopens it if they have
 * not been answered. Restricting resolution to the author would let them close
 * their own reviewer's questions unilaterally, which is the same failure the
 * self-approval rule exists to prevent — so the record keeps who closed it,
 * and the UI shows that name.
 */
export const POST = route<Params>(
  { action: "comment.resolve" },
  async ({ params, request, user }) => {
    assertAccess(await getProposalOrThrow(params.id), user, "view");
    const parsed = body.parse(await readJson(request));

    const comment = await setCommentResolved({
      proposalId: params.id,
      commentId: params.commentId,
      actorId: user.id,
      resolved: parsed.resolved,
    });

    return {
      proposalId: params.id,
      comment: { id: comment.id, resolved: comment.resolved_at !== null },
    };
  },
);
