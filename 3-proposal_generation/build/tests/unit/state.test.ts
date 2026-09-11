import test from "node:test";
import assert from "node:assert/strict";
import {
  STATUSES,
  TRANSITIONS,
  canTransition,
  assertTransition,
  assertCanApprove,
  assertCanWithdraw,
  assertCanSend,
  isEditable,
  isLocked,
  STATUS_META,
  type Status,
} from "../../lib/proposal/state";
import { AppError, ErrorCode } from "../../lib/errors";

/**
 * The approval and send gates are the requirements the PRD states most
 * plainly, so they are tested as rules rather than as UI behaviour: every
 * status is tried against every action, and the ones that must fail are
 * asserted to fail with a specific error code.
 */

function codeOf(fn: () => void): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (err) {
    return err instanceof AppError ? err.code : "NOT_APP_ERROR";
  }
}

test("every status has a transition entry", () => {
  for (const s of STATUSES) {
    assert.ok(TRANSITIONS[s] !== undefined, `${s} has no transition list`);
  }
});

test("every transition target is itself a valid status", () => {
  for (const from of STATUSES) {
    for (const to of TRANSITIONS[from]) {
      assert.ok(STATUSES.includes(to), `${from} → ${to} is not a real status`);
    }
  }
});

test("sent is terminal", () => {
  assert.deepEqual(TRANSITIONS.sent, []);
  for (const to of STATUSES) {
    assert.equal(canTransition("sent", to), false, `sent must not reach ${to}`);
  }
});

test("attempting to change a sent proposal reports ALREADY_SENT, not a generic refusal", () => {
  assert.equal(codeOf(() => assertTransition("sent", "review")), ErrorCode.ALREADY_SENT);
});

test("the happy path is walkable end to end", () => {
  const path: Status[] = [
    "draft",
    "generating",
    "review",
    "pending_approval",
    "approved",
    "sent",
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i]!;
    const to = path[i + 1]!;
    assert.ok(canTransition(from, to), `${from} → ${to} should be allowed`);
  }
});

test("a failed generation can get back to draft", () => {
  assert.ok(canTransition("generating", "draft"));
});

test("a failed delivery returns to approved so a retry re-runs every check", () => {
  assert.ok(canTransition("delivery_failed", "approved"));
});

test("review cannot jump straight to approved or sent", () => {
  assert.equal(canTransition("review", "approved"), false);
  assert.equal(canTransition("review", "sent"), false);
});

test("pending_approval cannot jump straight to sent", () => {
  assert.equal(canTransition("pending_approval", "sent"), false);
});

test("editability and locking are mutually exclusive", () => {
  for (const s of STATUSES) {
    assert.ok(!(isEditable(s) && isLocked(s)), `${s} cannot be both editable and locked`);
  }
  assert.ok(isEditable("review"));
  assert.ok(isEditable("changes_requested"));
  assert.ok(isLocked("pending_approval"));
  assert.ok(isLocked("sent"));
});

test("every status has UI metadata", () => {
  for (const s of STATUSES) {
    assert.ok(STATUS_META[s]?.label, `${s} has no label`);
  }
});

// -------------------------------------------------------------- approval gate

const APPROVABLE = {
  status: "pending_approval" as Status,
  actorId: "approver-1",
  actorRole: "approver" as const,
  authorId: "author-1",
  openBlockingGaps: 0,
};

test("a different approver with no open blocking gaps may approve", () => {
  assert.doesNotThrow(() => assertCanApprove(APPROVABLE));
});

test("a salesperson cannot approve", () => {
  assert.equal(
    codeOf(() => assertCanApprove({ ...APPROVABLE, actorRole: "salesperson" })),
    ErrorCode.FORBIDDEN_ROLE,
  );
});

test("admin may approve", () => {
  assert.doesNotThrow(() => assertCanApprove({ ...APPROVABLE, actorRole: "admin" }));
});

test("the author cannot approve their own proposal even as an approver", () => {
  assert.equal(
    codeOf(() => assertCanApprove({ ...APPROVABLE, actorId: "author-1" })),
    ErrorCode.SELF_APPROVAL_FORBIDDEN,
  );
});

test("the author cannot self-approve even as an admin", () => {
  // Separation of duties is about who wrote it, not about privilege level.
  assert.equal(
    codeOf(() => assertCanApprove({ ...APPROVABLE, actorId: "author-1", actorRole: "admin" })),
    ErrorCode.SELF_APPROVAL_FORBIDDEN,
  );
});

test("an open blocking gap prevents approval", () => {
  assert.equal(
    codeOf(() => assertCanApprove({ ...APPROVABLE, openBlockingGaps: 1 })),
    ErrorCode.BLOCKING_GAPS_OPEN,
  );
});

test("the blocking-gap message is singular for one and plural for many", () => {
  const one = (() => {
    try {
      assertCanApprove({ ...APPROVABLE, openBlockingGaps: 1 });
      return "";
    } catch (e) {
      return e instanceof AppError ? e.userMessage : "";
    }
  })();
  const many = (() => {
    try {
      assertCanApprove({ ...APPROVABLE, openBlockingGaps: 4 });
      return "";
    } catch (e) {
      return e instanceof AppError ? e.userMessage : "";
    }
  })();
  assert.match(one, /^One blocking gap/);
  assert.match(many, /^4 blocking gaps/);
});

test("approval is refused from every status except pending_approval", () => {
  for (const status of STATUSES) {
    if (status === "pending_approval") continue;
    const code = codeOf(() => assertCanApprove({ ...APPROVABLE, status }));
    assert.equal(code, ErrorCode.INVALID_TRANSITION, `${status} should not be approvable`);
  }
});

// ------------------------------------------------------------------ send gate

/** The user-facing message of whatever AppError a call throws. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    return err instanceof AppError ? err.userMessage : String(err);
  }
}

const SENDABLE = {
  status: "approved" as Status,
  actorRole: "salesperson" as const,
  openBlockingGaps: 0,
  hasValidRecipient: true,
};

test("an approved proposal with a valid recipient may be sent", () => {
  assert.doesNotThrow(() => assertCanSend(SENDABLE));
});

test("nothing reaches a client before approval — every pre-approval status is refused", () => {
  for (const status of ["draft", "generating", "review", "pending_approval", "changes_requested"] as Status[]) {
    assert.equal(
      codeOf(() => assertCanSend({ ...SENDABLE, status })),
      ErrorCode.NOT_APPROVED,
      `${status} must not be sendable`,
    );
  }
});

test("a sent proposal may be sent again, because the covering note can change", () => {
  /**
   * This used to assert the opposite, and the opposite was wrong.
   *
   * The status gate refused `sent` outright, which fired before the
   * idempotency key was computed and made the whole edited-note path
   * unreachable — while the deliver page told the user in plain words that
   * editing the note made it a genuine second send, and labelled the button
   * "Send again".
   *
   * What stops an accidental duplicate is not this function. It is
   * `deliveryIdempotencyKey` over the exact message plus a UNIQUE constraint
   * on `deliveries.idempotency_key`, which holds under concurrency in a way
   * a status check never could.
   */
  assert.doesNotThrow(() => assertCanSend({ ...SENDABLE, status: "sent" }));
});

test("a re-send is still subject to every other delivery check", () => {
  // The gate was widened, not removed. A gap reopened after the first send,
  // or a recipient edited into something invalid, must still stop the second.
  assert.equal(
    codeOf(() => assertCanSend({ ...SENDABLE, status: "sent", openBlockingGaps: 1 })),
    ErrorCode.BLOCKING_GAPS_OPEN,
  );
  assert.equal(
    codeOf(() => assertCanSend({ ...SENDABLE, status: "sent", hasValidRecipient: false })),
    ErrorCode.VALIDATION_FAILED,
  );
});

test("a sent proposal's content is still frozen, which is what makes a re-send safe", () => {
  // The safety argument for the test above, asserted rather than assumed: a
  // second send cannot carry text nobody approved, because nothing can edit a
  // sent proposal and no transition leads out of `sent`.
  assert.equal(isEditable("sent"), false);
  assert.equal(isLocked("sent"), true);
  assert.deepEqual([...TRANSITIONS.sent], []);
});

test("a previously failed delivery may be retried", () => {
  assert.doesNotThrow(() => assertCanSend({ ...SENDABLE, status: "delivery_failed" }));
});

test("a gap reopened after approval blocks the send", () => {
  assert.equal(
    codeOf(() => assertCanSend({ ...SENDABLE, openBlockingGaps: 1 })),
    ErrorCode.BLOCKING_GAPS_OPEN,
  );
});

test("the refusal names what is missing when the caller knows", () => {
  /**
   * The message used to say only that "a blocking gap was reopened after
   * approval". True, and a dead end: the deliver page does not show the gap
   * panel, so the person refused could not find out which gap. Naming the
   * field is the whole answer, and it is nearly always a field emptied after
   * the proposal was approved.
   */
  const one = messageOf(() =>
    assertCanSend({
      ...SENDABLE,
      openBlockingGaps: 1,
      blockingGapSummaries: [
        { field: "recommended_services", message: "Recommended services is empty." },
      ],
    }),
  );
  assert.match(one, /Recommended services is empty/);

  const two = messageOf(() =>
    assertCanSend({
      ...SENDABLE,
      openBlockingGaps: 2,
      blockingGapSummaries: [
        { field: "recommended_services", message: "Recommended services is empty." },
        { field: "project_scope", message: "Project scope is empty." },
      ],
    }),
  );
  assert.match(two, /2 things are missing/);
  assert.match(two, /Project scope is empty/);

  // With no summaries it still refuses, and still says what to do.
  const bare = messageOf(() => assertCanSend({ ...SENDABLE, openBlockingGaps: 1 }));
  assert.match(bare, /approved again/);
});

test("a missing recipient blocks the send with an actionable message", () => {
  assert.equal(
    codeOf(() => assertCanSend({ ...SENDABLE, hasValidRecipient: false })),
    ErrorCode.VALIDATION_FAILED,
  );
});

test("no transition path exists from any editable status directly to sent", () => {
  // Reachability check across the whole graph: the only way into `sent` is via
  // `approved` or `delivery_failed`.
  const intoSent = STATUSES.filter((s) => TRANSITIONS[s].includes("sent"));
  assert.deepEqual(intoSent.sort(), ["approved", "delivery_failed"]);
});

test("the only way into approved is from pending_approval or a failed delivery", () => {
  const intoApproved = STATUSES.filter((s) => TRANSITIONS[s].includes("approved"));
  assert.deepEqual(intoApproved.sort(), ["delivery_failed", "pending_approval"]);
});

// ------------------------------------------------- withdrawing a submission

/**
 * The deadlock these close.
 *
 * `pending_approval` used to lead only to `approved` and `changes_requested`,
 * both approver-only. An approver cannot approve a proposal with a blocking
 * gap open, so a salesperson who submitted early left the document frozen:
 * they could not edit it, and the only person who could move it could not
 * approve it either. One misclick, and the way out was for a reviewer to
 * guess that "request changes" was the workaround.
 */

const AUTHOR = "author-1";

function withdrawCtx(over: Partial<Parameters<typeof assertCanWithdraw>[0]> = {}) {
  return {
    status: "pending_approval" as const,
    actorId: AUTHOR,
    actorRole: "salesperson" as const,
    authorId: AUTHOR,
    ...over,
  };
}

test("an author can take their own submission back", () => {
  assert.doesNotThrow(() => assertCanWithdraw(withdrawCtx()));
  assert.equal(canTransition("pending_approval", "review"), true);
});

test("withdrawing returns it to review, where it is editable again", () => {
  // The point of withdrawing is to be able to fix something, so the status it
  // lands in has to be one the author can edit.
  assert.equal(isEditable("review"), true);
});

test("an approver cannot silently un-submit someone else's proposal", () => {
  // They have "request changes", which records a decision and a note. That
  // note is the part the author needs, and withdrawing would discard it.
  try {
    assertCanWithdraw(withdrawCtx({ actorId: "approver-1", actorRole: "approver" }));
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, ErrorCode.FORBIDDEN_ROLE);
  }
});

test("an admin can withdraw on the author's behalf", () => {
  // For the case where the author has left and the proposal is stuck.
  assert.doesNotThrow(() =>
    assertCanWithdraw(withdrawCtx({ actorId: "admin-1", actorRole: "admin" })),
  );
});

test("there is nothing to take back from a status that is already editable", () => {
  for (const status of ["draft", "review", "changes_requested"] as const) {
    try {
      assertCanWithdraw(withdrawCtx({ status }));
      assert.fail(`expected a refusal from ${status}`);
    } catch (err) {
      assert.ok(err instanceof AppError, status);
      assert.equal(err.code, ErrorCode.INVALID_TRANSITION, status);
    }
  }
});

// ------------------------------------------- recalling after approval

/**
 * The second half of the same deadlock.
 *
 * `approved` could reach `changes_requested` according to the transition
 * table, and could not in practice: the handler that performs that decision
 * refuses unless the status is `pending_approval`. So an approved proposal
 * was frozen. Nobody could edit it, and spotting a wrong figure between
 * approval and sending left one option, which was to send it anyway.
 */

test("an approved proposal can be recalled by its author", () => {
  assert.doesNotThrow(() => assertCanWithdraw(withdrawCtx({ status: "approved" })));
  assert.equal(canTransition("approved", "review"), true);
});

test("an approver can recall one too, because approving the wrong version is their mistake to undo", () => {
  assert.doesNotThrow(() =>
    assertCanWithdraw(
      withdrawCtx({ status: "approved", actorId: "approver-1", actorRole: "approver" }),
    ),
  );
});

test("another salesperson cannot recall someone else's approved proposal", () => {
  try {
    assertCanWithdraw(
      withdrawCtx({ status: "approved", actorId: "sales-2", actorRole: "salesperson" }),
    );
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, ErrorCode.FORBIDDEN_ROLE);
  }
});

test("nothing recalls a proposal that has been sent", () => {
  // It is a record of what a client received. No permission makes that untrue.
  for (const actor of [
    { actorId: AUTHOR, actorRole: "salesperson" as const },
    { actorId: "approver-1", actorRole: "approver" as const },
    { actorId: "admin-1", actorRole: "admin" as const },
  ]) {
    try {
      assertCanWithdraw(withdrawCtx({ status: "sent", ...actor }));
      assert.fail(`expected a refusal for ${actor.actorRole}`);
    } catch (err) {
      assert.ok(err instanceof AppError, actor.actorRole);
      assert.equal(err.code, ErrorCode.ALREADY_SENT, actor.actorRole);
    }
  }
  assert.equal(canTransition("sent", "review"), false);
});

test("recalling drops the client link, because review is not client-visible", () => {
  // share.ts serves approved, sent and delivery_failed only. Landing in
  // review is what makes the live URL stop resolving, so a recall actually
  // takes the document back rather than only relabelling it.
  assert.equal(canTransition("approved", "review"), true);
  assert.equal(isEditable("review"), true);
});

test("a recalled proposal still needs approving again before it can be sent", () => {
  // Otherwise recall is a way to edit a document after somebody signed it off.
  assert.equal(canTransition("review", "sent"), false);
  assert.equal(canTransition("review", "approved"), false);
  assert.equal(canTransition("review", "pending_approval"), true);
});

test("withdrawing does not become a route around approval", () => {
  // It must not reach a client-visible state, and it must not skip the
  // approval step: the only way to `approved` is still through an approver.
  assert.equal(canTransition("pending_approval", "sent"), false);
  assert.equal(canTransition("review", "approved"), false);
  assert.equal(canTransition("review", "sent"), false);
});
