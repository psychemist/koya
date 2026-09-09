import { z } from "zod";
import { readJson, route } from "../../../../../lib/api";
import { assertAccess } from "../../../../../lib/proposal/access";
import { addComment, getComments, getProposalOrThrow } from "../../../../../lib/proposal/repo";
import { isSectionKey } from "../../../../../lib/proposal/sections";
import { errors } from "../../../../../lib/errors";

type Params = { id: string };

/**
 * Review comments on a proposal.
 *
 * Anyone who may VIEW the proposal may comment on it — including an approver,
 * who may not edit a word of the document. That asymmetry is the point of the
 * feature: the reviewer's job is to raise the question, and the author's job
 * is to answer it. Requiring edit rights to leave a comment would have meant
 * the only people allowed to give feedback were the people who could act on it
 * themselves, which is not review.
 *
 * Comments are not part of the state machine and are readable at any status,
 * `sent` included — a proposal that has gone out is exactly the one somebody
 * later asks questions about.
 */

const postBody = z.object({
  body: z.string().trim().min(1).max(4000),
  sectionKey: z.string().trim().max(64).optional(),
});

export const GET = route<Params>({ action: "comment.list" }, async ({ params, user }) => {
  assertAccess(await getProposalOrThrow(params.id), user, "view");
  const comments = await getComments(params.id);
  return { proposalId: params.id, comments: comments.map(shape) };
});

export const POST = route<Params>({ action: "comment.create" }, async ({ params, request, user }) => {
  assertAccess(await getProposalOrThrow(params.id), user, "view");
  const parsed = postBody.parse(await readJson(request));

  // A comment addressed to a section that does not exist would render nowhere
  // and be silently lost, which is worse than being refused.
  if (parsed.sectionKey && !isSectionKey(parsed.sectionKey)) {
    throw errors.notFound(`Section "${parsed.sectionKey}"`);
  }

  const comment = await addComment({
    proposalId: params.id,
    sectionKey: parsed.sectionKey ?? null,
    authorId: user.id,
    body: parsed.body,
  });

  return {
    proposalId: params.id,
    comment: { ...shape({ ...comment, author_name: user.name, resolver_name: null }) },
  };
});

function shape(c: {
  id: string;
  section_key: string | null;
  body: string;
  author_name: string;
  resolved_at: Date | null;
  resolver_name: string | null;
  created_at: Date;
}) {
  return {
    id: c.id,
    sectionKey: c.section_key,
    body: c.body,
    authorName: c.author_name,
    resolved: c.resolved_at !== null,
    resolverName: c.resolver_name,
    createdAt: c.created_at,
  };
}
