import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ROLES, assertEmail, isRole, normaliseEmail } from "../../lib/team";
import { AppError, ErrorCode } from "../../lib/errors";

/**
 * The pure half of team administration.
 *
 * Address normalisation is not cosmetic here: the string this produces is
 * what a registration is matched against, so a rule that folds two different
 * mailboxes into one grants access to an address nobody authorised. The
 * database guards (last-admin, no self-promotion) need Postgres and are
 * exercised by scripts/verify-team.ts against the live branch.
 */

function reason(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError);
    return err;
  }
  throw new Error("expected a rejection");
}

test("addresses are matched case-insensitively", () => {
  // users.email is indexed on lower(email) and sign-in lowercases before
  // lookup, so the invite list has to agree or an authorised address fails
  // to register purely because of how it was typed.
  assert.equal(normaliseEmail("  Priya.Raman@Northgate.CO.UK "), "priya.raman@northgate.co.uk");
});

test("dots and plus-tags are preserved, because they are not ours to remove", () => {
  // Gmail treats these as noise. No other provider is obliged to, and
  // stripping them would silently merge two real mailboxes into one
  // authorisation.
  assert.equal(normaliseEmail("a.b+koya@example.com"), "a.b+koya@example.com");
  assert.notEqual(normaliseEmail("a.b@example.com"), normaliseEmail("ab@example.com"));
});

test("something that is not an address is refused before it reaches the list", () => {
  for (const bad of ["", "   ", "priya", "priya@", "@example.com", "a b@example.com", "a@b"]) {
    const err = reason(() => assertEmail(bad));
    assert.equal(err.code, ErrorCode.VALIDATION_FAILED, bad);
  }
});

test("an absurdly long address is refused", () => {
  const err = reason(() => assertEmail(`${"a".repeat(250)}@example.com`));
  assert.equal(err.code, ErrorCode.VALIDATION_FAILED);
});

test("a valid address comes back normalised, not merely accepted", () => {
  assert.equal(assertEmail("  Ops@Example.com "), "ops@example.com");
});

test("the three roles are the three the schema allows", () => {
  // The CHECK constraint in 001_init.sql lists exactly these. A fourth role
  // added here and not there fails at the insert, in production, on the
  // first person invited to it.
  assert.deepEqual([...ROLES].sort(), ["admin", "approver", "salesperson"]);
});

test("role validation rejects anything else", () => {
  assert.equal(isRole("approver"), true);
  assert.equal(isRole("Approver"), false);
  assert.equal(isRole("superuser"), false);
  assert.equal(isRole(""), false);
});
