import { AppError, ErrorCode, errors } from "../errors";
import type { Role, User } from "../auth";

/**
 * Who may do what to a proposal.
 *
 * Every route in this application was already role-gated — `route()` refuses a
 * request whose session does not hold `salesperson` or `approver`. That is a
 * check on WHAT the caller is, and it was mistaken for a check on WHETHER THIS
 * PROPOSAL IS THEIRS. It is not. Holding the salesperson role is not a claim
 * over every salesperson's work, and until this module existed, one signed-in
 * salesperson could regenerate, edit, revert, submit and send a colleague's
 * proposal by addressing its id directly.
 *
 * The user interface never offered any of that: the workspace passes an
 * `isAuthor` flag and hides the controls. Hiding a control is a courtesy to
 * the person who should not use it, never a boundary against the person who
 * means to. The boundary is here, on the server, on the way in.
 *
 * Three capabilities, because the roles genuinely differ in what they need:
 *
 *   view   — the author, any approver, an admin. An approver has to read a
 *            proposal to judge it, including before it is formally theirs.
 *   edit   — the author, or an admin. Deliberately NOT approvers: an approver
 *            who rewrites the document is no longer an independent reviewer of
 *            it, and the separation of duties that `assertCanApprove` enforces
 *            at the moment of approval would be hollow if they had authored
 *            half the text. An approver who wants changes sends it back.
 *   send   — the author, an approver, or an admin, and only ever after
 *            `assertCanSend` has agreed the status permits it.
 *
 * Admin passes everything, matching `requireRole`.
 */

export type Capability = "view" | "edit" | "send";

/** The subset of a proposal this module needs. Keeps callers from over-fetching. */
export type AccessSubject = { id: string; author_id: string };

function isApprover(role: Role): boolean {
  return role === "approver" || role === "admin";
}

export function canAccess(
  proposal: AccessSubject,
  actor: { id: string; role: Role },
  capability: Capability,
): boolean {
  if (actor.role === "admin") return true;
  const author = proposal.author_id === actor.id;

  switch (capability) {
    case "view":
      return author || isApprover(actor.role);
    case "edit":
      return author;
    case "send":
      return author || isApprover(actor.role);
  }
}

/**
 * The enforcement point. Throws if the actor may not do this.
 *
 * A caller who may not even VIEW the proposal gets NOT_FOUND rather than
 * FORBIDDEN. Answering "you are not allowed to touch proposal X" confirms that
 * X exists and that someone in the firm is working on it, which is more than a
 * stranger to that deal should learn from an id they guessed. A caller who may
 * view but not edit gets the honest 403, because they already know it exists.
 */
export function assertAccess(
  proposal: AccessSubject,
  actor: User,
  capability: Capability,
): void {
  if (canAccess(proposal, actor, capability)) return;

  if (!canAccess(proposal, actor, "view")) {
    throw errors.notFound("That proposal");
  }

  throw new AppError({
    code: ErrorCode.FORBIDDEN_ROLE,
    userMessage:
      capability === "edit"
        ? "Only the salesperson who created this proposal can change it. Ask them to make the edit, or send it back for changes."
        : "You do not have permission to do that with this proposal.",
    detail: { capability, actorRole: actor.role, actorId: actor.id, proposalId: proposal.id },
  });
}
