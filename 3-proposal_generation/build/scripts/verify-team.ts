/**
 * Verifies the team guards against the real database.
 *
 * The three rules that matter are enforced by queries, not by types, so a
 * unit test with a mocked pool would prove nothing about them:
 *
 *   1. Nobody can change their own role.
 *   2. The last active administrator cannot be demoted or deactivated.
 *   3. A live invite is unique per address, case-insensitively.
 *
 * SAFETY. Every account this creates uses the reserved `.invalid` TLD, so no
 * fixture address can collide with a real one, and every statement that
 * removes a row is scoped to that suffix. The last-admin assertions are
 * skipped unless the branch's only live administrator is one of the fixtures.
 *
 * Run with: npm run verify:team
 */

import { query, queryOne } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { invite, registerFromInvite, setActive, setRole } from "../lib/team";
import { AppError } from "../lib/errors";
import type { User } from "../lib/auth";

const TAG = "verify-team.invalid";
const FIXTURES = `%@${TAG}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(name: string, fn: () => Promise<unknown>, expect: RegExp) {
  try {
    await fn();
    check(name, false, "it was allowed");
  } catch (err) {
    const message = err instanceof AppError ? err.userMessage : String(err);
    check(name, expect.test(message), `wrong reason: ${message}`);
  }
}

async function makeUser(local: string, role: User["role"]): Promise<User> {
  const email = `${local}@${TAG}`;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [email, `Test ${local}`, role, await hashPassword("x".repeat(24))],
  );
  if (!row) throw new Error("could not create the test user");
  return { id: row.id, email, name: `Test ${local}`, role, is_active: true };
}

/** Removes every fixture row. Scoped to the reserved-TLD suffix, always. */
async function cleanup() {
  await query(`DELETE FROM team_invites WHERE email LIKE $1`, [FIXTURES]);
  await query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [FIXTURES],
  );
  await query(`DELETE FROM users WHERE email LIKE $1`, [FIXTURES]);
}

async function liveAdmins(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active",
  );
  return row?.n ?? 0;
}

async function main() {
  await cleanup();

  const realAdmins = await liveAdmins();
  const admin = await makeUser("admin-a", "admin");
  const admin2 = await makeUser("admin-b", "admin");
  const sales = await makeUser("sales", "salesperson");

  console.log("\nSelf-service is refused");
  await rejects(
    "an admin cannot change their own role",
    () => setRole({ actor: admin, userId: admin.id, role: "salesperson" }),
    /cannot change your own role/i,
  );
  await rejects(
    "an admin cannot deactivate themselves",
    () => setActive({ actor: admin, userId: admin.id, active: false }),
    /cannot deactivate your own account/i,
  );

  console.log("\nOrdinary changes work");
  const promoted = await setRole({ actor: admin, userId: sales.id, role: "approver" });
  check("a salesperson can be promoted to approver", promoted.role === "approver", promoted.role);

  const off = await setActive({ actor: admin, userId: sales.id, active: false });
  check("a member can be deactivated", off.is_active === false);

  const on = await setActive({ actor: admin, userId: sales.id, active: true });
  check("and reactivated at the same role", on.is_active && on.role === "approver");

  console.log("\nThe organisation cannot lock itself out");
  if (realAdmins === 0) {
    // Leave exactly one live admin: the first fixture.
    await setActive({ actor: admin, userId: admin2.id, active: false });
    check("the fixtures leave exactly one live admin", (await liveAdmins()) === 1);
    await rejects(
      "the last admin cannot be demoted by another account",
      () => setRole({ actor: sales, userId: admin.id, role: "salesperson" }),
      /only active administrator/i,
    );
    await rejects(
      "the last admin cannot be deactivated",
      () => setActive({ actor: sales, userId: admin.id, active: false }),
      /only active administrator/i,
    );
    await setActive({ actor: admin, userId: admin2.id, active: true });
  } else {
    console.log(
      `  skip this branch already has ${realAdmins} live administrator(s), so the guard cannot be exercised without touching a real account`,
    );
  }

  console.log("\nThe authorised-address list");
  const first = await invite({ actor: admin, email: `New.Person@${TAG}`, role: "approver" });
  check("an address is stored lowercased", first.email === `new.person@${TAG}`, first.email);

  await rejects(
    "the same address in a different case is refused",
    () => invite({ actor: admin, email: `NEW.PERSON@${TAG}`, role: "admin" }),
    /already on the list/i,
  );
  await rejects(
    "an existing member cannot be invited again",
    () => invite({ actor: admin, email: sales.email, role: "admin" }),
    /already has an account/i,
  );

  console.log("\nRegistration takes its role from the invite, not the form");
  await registerFromInvite({
    email: `NEW.PERSON@${TAG}`,
    name: "New Person",
    password: "correct horse battery staple",
  });
  const created = await queryOne<{ role: string }>(
    "SELECT role FROM users WHERE lower(email) = $1",
    [`new.person@${TAG}`],
  );
  check("the account is created at the invited role", created?.role === "approver", created?.role);

  await rejects(
    "the same invite cannot be used twice",
    () =>
      registerFromInvite({
        email: `new.person@${TAG}`,
        name: "Impostor",
        password: "another twelve plus characters",
      }),
    /cannot register/i,
  );
  await rejects(
    "an address nobody authorised cannot register",
    () =>
      registerFromInvite({
        email: `stranger@${TAG}`,
        name: "Stranger",
        password: "another twelve plus characters",
      }),
    /cannot register/i,
  );

  const withdrawn = await invite({ actor: admin, email: `later@${TAG}`, role: "salesperson" });
  await query("UPDATE team_invites SET revoked_at = now() WHERE id = $1", [withdrawn.id]);
  await rejects(
    "a withdrawn authorisation cannot register",
    () =>
      registerFromInvite({
        email: `later@${TAG}`,
        name: "Later",
        password: "another twelve plus characters",
      }),
    /cannot register/i,
  );
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    await cleanup().catch(() => undefined);
    console.error("\nverify-team crashed:", err);
    process.exit(1);
  });
