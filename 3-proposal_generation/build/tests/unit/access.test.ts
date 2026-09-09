import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canAccess, assertAccess } from "../../lib/proposal/access";
import { AppError, ErrorCode } from "../../lib/errors";
import type { User } from "../../lib/auth";

/**
 * The regression suite for the hole these tests were written after finding:
 * every proposal route was role-gated and none was owner-gated, so any
 * signed-in salesperson could act on a colleague's proposal by id.
 */

const PROPOSAL = { id: "11111111-1111-1111-1111-111111111111", author_id: "author-1" };

function user(id: string, role: User["role"]): User {
  return { id, email: `${id}@example.com`, name: id, role, is_active: true };
}

const author = user("author-1", "salesperson");
const otherSales = user("sales-2", "salesperson");
const approver = user("approver-1", "approver");
const admin = user("admin-1", "admin");

test("the author may view, edit and send their own proposal", () => {
  for (const cap of ["view", "edit", "send"] as const) {
    assert.equal(canAccess(PROPOSAL, author, cap), true, cap);
  }
});

test("a second salesperson may do nothing at all with it", () => {
  for (const cap of ["view", "edit", "send"] as const) {
    assert.equal(canAccess(PROPOSAL, otherSales, cap), false, cap);
  }
});

test("an approver may view and send, but never edit", () => {
  assert.equal(canAccess(PROPOSAL, approver, "view"), true);
  assert.equal(canAccess(PROPOSAL, approver, "send"), true);
  // An approver who rewrites the document is no longer an independent
  // reviewer of it, which would hollow out the separation of duties that
  // assertCanApprove enforces at the moment of approval.
  assert.equal(canAccess(PROPOSAL, approver, "edit"), false);
});

test("admin passes every capability", () => {
  for (const cap of ["view", "edit", "send"] as const) {
    assert.equal(canAccess(PROPOSAL, admin, cap), true, cap);
  }
});

test("edit rights follow authorship, not the approver role", () => {
  // The author keeps edit rights whatever second role they hold...
  assert.equal(canAccess(PROPOSAL, user("author-1", "approver"), "edit"), true);
  // ...and an approver who did not write it never gains them.
  assert.equal(canAccess(PROPOSAL, user("approver-9", "approver"), "edit"), false);
});

test("a caller who cannot even view gets NOT_FOUND, not FORBIDDEN", () => {
  // Answering "forbidden" would confirm the proposal exists to someone who
  // guessed its id.
  assert.throws(
    () => assertAccess(PROPOSAL, otherSales, "edit"),
    (err: unknown) => err instanceof AppError && err.code === ErrorCode.NOT_FOUND,
  );
});

test("a viewer who may not edit gets the honest 403", () => {
  assert.throws(
    () => assertAccess(PROPOSAL, approver, "edit"),
    (err: unknown) =>
      err instanceof AppError && err.code === ErrorCode.FORBIDDEN_ROLE && err.httpStatus === 403,
  );
});

test("assertAccess is silent when the actor is allowed", () => {
  assert.doesNotThrow(() => assertAccess(PROPOSAL, author, "edit"));
  assert.doesNotThrow(() => assertAccess(PROPOSAL, approver, "view"));
  assert.doesNotThrow(() => assertAccess(PROPOSAL, admin, "send"));
});

test("no refusal message leaks another user's identity", () => {
  try {
    assertAccess(PROPOSAL, approver, "edit");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.ok(!err.userMessage.includes("author-1"), "author id must not be shown");
  }
});
