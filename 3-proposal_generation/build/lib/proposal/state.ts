import { AppError, ErrorCode, errors } from "../errors";
import { humanStatus, type Status } from "./status";
import type { Role } from "../auth";

// Re-exported so existing imports of `Status` / `STATUSES` from this module
// keep working; the definitions live in status.ts, which has no dependencies
// and is therefore safe for client components to import.
export { STATUSES, STATUS_META, isStatus, humanStatus, type Status, type Tone } from "./status";

/**
 * The proposal lifecycle, as a pure function of (state, action).
 *
 * Keeping this separate from the database access is what lets every rule be
 * tested without a connection, and it is where the PRD's "the proposal should
 * not be sent to the client before internal approval" actually lives. The UI
 * hides the send button before approval; this module makes the send *fail*,
 * which is the difference between a convention and a control.
 */

/**
 * Allowed edges. Anything not listed is refused.
 *
 * Two edges deserve a note:
 *
 *   generating → draft is the recovery path. A generation that dies partway
 *   leaves the proposal in `generating`, and without a way back it would be
 *   stuck for ever. The retry path is explicit rather than implicit.
 *
 *   delivery_failed → approved returns a proposal to the state it was in
 *   before the send attempt, so a retry goes through exactly the same checks
 *   as the first attempt. It is not a shortcut back to `sent`.
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ["generating"],
  generating: ["review", "draft"],
  review: ["review", "generating", "pending_approval"],
  /**
   * `review` is here so the author can take a submission back.
   *
   * Without it this status is a trap. Submitting is the one irreversible
   * thing a salesperson can do: only an approver may move a proposal out of
   * `pending_approval`, and an approver cannot approve one that still has a
   * blocking gap open. Submit too early and the document is frozen with the
   * author unable to edit it and the approver unable to clear it, until
   * somebody thinks to press "request changes" as a workaround. That is a
   * deadlock reachable by a single misclick.
   *
   * Withdrawing is guarded separately by `assertCanWithdraw`: the author may
   * recall their own submission, but only while nobody has decided on it.
   */
  pending_approval: ["approved", "changes_requested", "review"],
  changes_requested: ["review", "generating", "pending_approval"],
  /**
   * `review` is here for the same reason it is on `pending_approval`.
   *
   * An approved proposal that has not been sent is not finished, it is
   * loaded. Spotting a wrong figure at that point used to have no answer:
   * the author could not edit an approved proposal, and `changes_requested`
   * is declared below but was unreachable from here, because the handler
   * that performs it refuses unless the status is `pending_approval`. So
   * the transition existed in this table and nothing could ever take it.
   *
   * Recalling drops the proposal back to `review`, which also stops the
   * client link resolving, because `share.ts` only serves approved, sent and
   * delivery_failed. Re-approval is then required before it can go out,
   * which is the point: a recall must not be a way to change a document
   * after somebody signed it off.
   */
  approved: ["sent", "delivery_failed", "changes_requested", "review"],
  // Terminal. A sent proposal is a record of what a client received; changing
  // it would make the audit trail describe a document that no longer exists.
  sent: [],
  delivery_failed: ["approved", "sent"],
};

export function canTransition(from: Status, to: Status): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: Status, to: Status): void {
  if (canTransition(from, to)) return;
  if (from === "sent") {
    throw new AppError({
      code: ErrorCode.ALREADY_SENT,
      userMessage:
        "This proposal has already been sent to the client, so it cannot be changed. Duplicate it to work on a new version.",
      detail: { from, to },
    });
  }
  throw errors.invalidTransition(from, to);
}

/** Statuses in which the document body may still be edited. */
export function isEditable(status: Status): boolean {
  return status === "draft" || status === "review" || status === "changes_requested";
}

/** Statuses whose content is frozen because someone is acting on it. */
export function isLocked(status: Status): boolean {
  return status === "pending_approval" || status === "approved" || status === "sent";
}

export type ApprovalContext = {
  status: Status;
  actorId: string;
  actorRole: Role;
  authorId: string;
  openBlockingGaps: number;
};

/**
 * Everything that must be true before a proposal can be approved.
 *
 * Checked in this order deliberately: role, then separation of duties, then
 * state, then gaps. The messages get more specific as they go, so a
 * salesperson clicking Approve is told they lack the role rather than being
 * told about gaps they cannot approve away anyway.
 */
export function assertCanApprove(ctx: ApprovalContext): void {
  if (ctx.actorRole !== "approver" && ctx.actorRole !== "admin") {
    throw errors.forbiddenRole("approver", ctx.actorRole);
  }

  // Separation of duties. The whole point of the approval step is that a
  // second person looked at it, so the author cannot be that person — even
  // when the author happens to hold the approver role.
  if (ctx.actorId === ctx.authorId) {
    throw new AppError({
      code: ErrorCode.SELF_APPROVAL_FORBIDDEN,
      userMessage:
        "You wrote this proposal, so you cannot approve it. The point of approval is a second pair of eyes, so ask another approver.",
      detail: { actorId: ctx.actorId },
    });
  }

  if (ctx.status !== "pending_approval") {
    throw new AppError({
      code: ErrorCode.INVALID_TRANSITION,
      userMessage: `This proposal is ${humanStatus(ctx.status)}, so there is nothing to approve. It must be submitted for approval first.`,
      detail: { status: ctx.status },
    });
  }

  if (ctx.openBlockingGaps > 0) {
    throw new AppError({
      code: ErrorCode.BLOCKING_GAPS_OPEN,
      userMessage:
        ctx.openBlockingGaps === 1
          ? "One blocking gap is still open. Resolve it, or waive it with a written reason, before approving."
          : `${ctx.openBlockingGaps} blocking gaps are still open. Resolve them, or waive them with a written reason, before approving.`,
      detail: { openBlockingGaps: ctx.openBlockingGaps },
    });
  }
}

export type WithdrawContext = {
  status: Status;
  actorId: string;
  actorRole: Role;
  authorId: string;
};

/** The two states a proposal can be pulled back from, and never `sent`. */
const RECALLABLE = new Set<Status>(["pending_approval", "approved"]);

/**
 * Taking a proposal back, before it has gone anywhere.
 *
 * Two cases, and they need different permissions.
 *
 * From `pending_approval` this is the author withdrawing their own
 * submission. Deliberately NOT open to approvers: an approver who wants
 * changes has "request changes", which records a decision and a note
 * against their name, and silently un-submitting would lose the one part of
 * that exchange the author needs.
 *
 * From `approved` it is a recall, and an approver may do it too, because
 * approving the wrong version is a mistake an approver makes and should be
 * able to undo. It stays impossible once the proposal is `sent`: that is a
 * record of what a client received, and no amount of permission makes it
 * untrue.
 */
export function assertCanWithdraw(ctx: WithdrawContext): void {
  if (ctx.status === "sent") {
    throw new AppError({
      code: ErrorCode.ALREADY_SENT,
      userMessage:
        "This has already gone to the client, so it cannot be recalled. Duplicate it to work on a new version.",
      detail: { status: ctx.status },
    });
  }

  if (!RECALLABLE.has(ctx.status)) {
    throw new AppError({
      code: ErrorCode.INVALID_TRANSITION,
      userMessage: `This proposal is ${humanStatus(ctx.status)}, so there is nothing to take back. It is already yours to edit.`,
      detail: { status: ctx.status },
    });
  }

  const isAuthor = ctx.actorId === ctx.authorId;
  const isAdmin = ctx.actorRole === "admin";
  const isApprover = ctx.actorRole === "approver";

  if (ctx.status === "approved") {
    if (!isAuthor && !isAdmin && !isApprover) {
      throw new AppError({
        code: ErrorCode.FORBIDDEN_ROLE,
        userMessage: "Only the author or an approver can recall an approved proposal.",
        detail: { actorId: ctx.actorId },
      });
    }
    return;
  }

  if (!isAuthor && !isAdmin) {
    throw new AppError({
      code: ErrorCode.FORBIDDEN_ROLE,
      userMessage:
        "Only the person who submitted this can withdraw it. If you are reviewing it and want changes, send it back with a note saying what to fix.",
      detail: { actorId: ctx.actorId },
    });
  }
}

export type SendContext = {
  status: Status;
  actorRole: Role;
  openBlockingGaps: number;
  /**
   * What the open blocking gaps actually are, when the caller has them.
   *
   * Optional so every existing call site keeps working, and supplied by the
   * send route so the refusal can say which field is empty. The count alone
   * produced a message that was true and unusable.
   */
  blockingGapSummaries?: readonly { field: string | null; message: string }[];
  hasValidRecipient: boolean;
};

/**
 * The gate the PRD is most explicit about. A proposal reaches a client only
 * from `approved` or from a previously failed delivery of an approved
 * proposal — never from `review`, and never from `pending_approval`.
 */
export function assertCanSend(ctx: SendContext): void {
  /**
   * `sent` is deliberately NOT refused here, and it used to be.
   *
   * The refusal read "This proposal has already been sent. It will not be
   * sent twice", and it fired before the idempotency key was ever computed —
   * so the machinery built to tell a duplicate from a genuine second send was
   * unreachable. Every other layer of the system already disagreed with it:
   * the deliver page admits a `sent` proposal, the panel promises in so many
   * words that editing the note makes it a real second send, and the button
   * itself says "Send again". It did not. The user pressed a button the
   * product had explained to them and was told no.
   *
   * Allowing it is safe, and specifically because of two other rules rather
   * than because duplicates do not matter:
   *
   *   `TRANSITIONS.sent` is empty and `isLocked("sent")` is true, so the
   *   approved document is frozen. A second send cannot carry content that
   *   nobody approved — only the covering note can differ, and that note is
   *   not part of the proposal.
   *
   *   `deliveryIdempotencyKey` covers the proposal, the recipient and the
   *   exact message, and `deliveries.idempotency_key` is UNIQUE. Pressing
   *   Send twice on an unchanged message is still one delivery; the second
   *   press comes back as `delivery.duplicate_suppressed` and nothing is
   *   sent. That is the check that belongs in the database, where a race
   *   cannot get past it, rather than in a status gate.
   *
   * So the guarantee the old line was reaching for is intact. What changed is
   * where it is enforced: on the exact message, atomically, instead of on the
   * status, categorically.
   *
   * The blocking-gap and recipient checks below still apply to a re-send, and
   * they are the reason this is a widened gate rather than a removed one.
   */
  if (ctx.status !== "approved" && ctx.status !== "delivery_failed" && ctx.status !== "sent") {
    throw new AppError({
      code: ErrorCode.NOT_APPROVED,
      userMessage: `This proposal is ${humanStatus(ctx.status)}. Nothing reaches a client before internal approval.`,
      detail: { status: ctx.status },
    });
  }

  // Re-checked at send time even though approval already checked it: a gap
  // can be reopened after approval, and the send is the last chance to catch
  // it before a client sees it.
  if (ctx.openBlockingGaps > 0) {
    /**
     * Named, not counted.
     *
     * This said only that "a blocking gap was reopened after approval", which
     * is accurate and leads nowhere: the deliver page does not show the gap
     * panel, so the person refused had no way to learn which gap or what was
     * missing. The usual cause is a field emptied after the proposal was
     * approved, and the field name is the whole answer.
     */
    const named = (ctx.blockingGapSummaries ?? [])
      .map((g) => g.message)
      .filter((m) => m.trim().length > 0);

    const detail =
      named.length === 0
        ? ""
        : named.length === 1
          ? ` ${named[0]}`
          : ` ${named.length} things are missing: ${named.join(" ")}`;

    throw new AppError({
      code: ErrorCode.BLOCKING_GAPS_OPEN,
      userMessage:
        `This cannot be sent while something it needs is missing, which usually means a field was emptied after it was approved.${detail} ` +
        "Fix it in the workspace, then have it approved again.",
      detail: {
        openBlockingGaps: ctx.openBlockingGaps,
        fields: (ctx.blockingGapSummaries ?? []).map((g) => g.field),
      },
    });
  }

  if (!ctx.hasValidRecipient) {
    throw new AppError({
      code: ErrorCode.VALIDATION_FAILED,
      userMessage:
        "There is no valid client email address on this proposal, so it cannot be emailed. Add one, or share the proposal link instead.",
    });
  }
}

