/**
 * Verifies the Activity page's visibility scope against the real database.
 *
 * The rule this proves is a data rule, not a type rule: a salesperson must not
 * be able to read the action log of a colleague's deal. That is enforced by
 * the WHERE clause in `scopeClause`, so a unit test with a mocked pool would
 * assert nothing about the thing that can actually go wrong — and what goes
 * wrong with a scope clause is that it silently matches too much.
 *
 * So the check is comparative rather than absolute: two salespeople each
 * write an event against their own proposal, and each must see their own and
 * not the other's. An assertion that merely counted rows would pass against a
 * clause that returned everything.
 *
 * SAFETY. Every account uses the reserved `.invalid` TLD and every fixture is
 * removed at the end, so this is safe against a database with real data in it.
 *
 * Run with: npm run verify:activity
 */

import { query, queryOne } from "../lib/db";
import { closePool } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { recordEvent } from "../lib/audit";
import { listProposals } from "../lib/proposal/repo";
import {
  activityTotals,
  DEFAULT_PAGE_SIZE,
  listActivity,
  listActors,
  MAX_PAGE_SIZE,
} from "../lib/activity";
import type { User } from "../lib/auth";

const TAG = "verify-activity.invalid";

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

async function makeUser(local: string, role: User["role"]): Promise<User> {
  const email = `${local}@${TAG}`;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [email, `Activity ${local}`, role, await hashPassword("x".repeat(24))],
  );
  if (!row) throw new Error("could not create the test user");
  return { id: row.id, email, name: `Activity ${local}`, role, is_active: true };
}

async function makeProposal(author: User, ref: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO proposals (ref, author_id, title, intake)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [ref, author.id, `Activity fixture ${ref}`, JSON.stringify({ company_name: "Fixture Co" })],
  );
  if (!row) throw new Error("could not create the test proposal");
  return row.id;
}

async function cleanup(): Promise<void> {
  // Proposals first: events reference them, and the erasure trigger has to be
  // allowed to do its job rather than being worked around here.
  await query(
    `DELETE FROM proposals WHERE author_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%@${TAG}`],
  );
  await query(`DELETE FROM events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE $1)`, [
    `%@${TAG}`,
  ]);
  await query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TAG}`]);
}

async function main(): Promise<void> {
  await cleanup();

  const alice = await makeUser("alice", "salesperson");
  const bob = await makeUser("bob", "salesperson");
  const approver = await makeUser("approver", "approver");
  const admin = await makeUser("admin", "admin");

  const alicesProposal = await makeProposal(alice, `VA-${Date.now()}-A`);
  const bobsProposal = await makeProposal(bob, `VA-${Date.now()}-B`);

  const run = `verify-activity-${Date.now()}`;
  await recordEvent({
    correlationId: `${run}-a`,
    action: "proposal.generate",
    outcome: "ok",
    actorId: alice.id,
    proposalId: alicesProposal,
  });
  await recordEvent({
    correlationId: `${run}-b`,
    action: "proposal.send",
    outcome: "ok",
    actorId: bob.id,
    proposalId: bobsProposal,
  });
  await recordEvent({
    correlationId: `${run}-approve`,
    action: "proposal.approve",
    outcome: "ok",
    actorId: approver.id,
    proposalId: alicesProposal,
  });

  const mine = (rows: { correlation_id: string }[], id: string) =>
    rows.some((r) => r.correlation_id === id);

  const aliceRows = await listActivity(alice, { limit: 400 });
  check("a salesperson sees their own action", mine(aliceRows, `${run}-a`));
  check(
    "a salesperson sees an approval on their own proposal",
    mine(aliceRows, `${run}-approve`),
  );
  check(
    "a salesperson does NOT see a colleague's action on a colleague's proposal",
    !mine(aliceRows, `${run}-b`),
  );

  const bobRows = await listActivity(bob, { limit: 400 });
  check("the other salesperson sees their own action", mine(bobRows, `${run}-b`));
  check("the other salesperson does NOT see the first one's", !mine(bobRows, `${run}-a`));

  const approverRows = await listActivity(approver, { limit: 400 });
  check(
    "an approver sees events on any proposal, matching canAccess view",
    mine(approverRows, `${run}-a`) && mine(approverRows, `${run}-b`),
  );

  const adminRows = await listActivity(admin, { limit: 400 });
  check(
    "an administrator sees everything",
    mine(adminRows, `${run}-a`) && mine(adminRows, `${run}-b`) && mine(adminRows, `${run}-approve`),
  );

  // The person filter must not become a way around the scope.
  const aliceFilteringBob = await listActivity(alice, { actorId: bob.id, limit: 400 });
  check(
    "filtering by a colleague's id returns nothing rather than their trail",
    !mine(aliceFilteringBob, `${run}-b`),
  );

  const aliceApprovals = await listActivity(alice, { group: "approval", limit: 400 });
  check(
    "the group filter narrows rather than widens",
    mine(aliceApprovals, `${run}-approve`) && !mine(aliceApprovals, `${run}-a`),
  );

  const aliceOk = await listActivity(alice, { outcome: "error", limit: 400 });
  check("the outcome filter excludes successes", !mine(aliceOk, `${run}-a`));

  const aliceActors = await listActors(alice);
  check(
    "the people roll-up does not name a colleague a salesperson cannot see",
    !aliceActors.some((a) => a.actor_id === bob.id),
  );

  const adminActors = await listActors(admin);
  check(
    "the people roll-up names everyone for an administrator",
    [alice.id, bob.id, approver.id].every((id) => adminActors.some((a) => a.actor_id === id)),
  );

  const adminTotals = await activityTotals(admin);
  const aliceTotals = await activityTotals(alice);
  check(
    "totals are scoped the same way the list is",
    adminTotals.events > aliceTotals.events,
    `admin ${adminTotals.events} vs salesperson ${aliceTotals.events}`,
  );

  // ------------------------------------------------------------- paging
  /**
   * Offset paging, checked for the two ways it usually breaks: a page that
   * repeats a row from the previous one, and a page that skips one. Both come
   * from an unstable sort, which is why the query orders by `at DESC, id DESC`
   * — `at` alone is not unique and two events written in the same millisecond
   * would shuffle between queries.
   */
  const pageOne = await listActivity(admin, { limit: DEFAULT_PAGE_SIZE, offset: 0 });
  const pageTwo = await listActivity(admin, { limit: DEFAULT_PAGE_SIZE, offset: DEFAULT_PAGE_SIZE });

  check(
    `a page holds at most ${DEFAULT_PAGE_SIZE} rows`,
    pageOne.length <= DEFAULT_PAGE_SIZE,
    `got ${pageOne.length}`,
  );

  const firstIds = new Set(pageOne.map((r) => r.id));
  check(
    "the second page repeats nothing from the first",
    pageTwo.every((r) => !firstIds.has(r.id)),
  );

  const overlapping = await listActivity(admin, { limit: DEFAULT_PAGE_SIZE, offset: 1 });
  check(
    "the ordering is stable, so paging skips nothing",
    // Offsetting by one must return exactly the first page shifted by one.
    pageOne.length < 2 ||
      overlapping.slice(0, pageOne.length - 1).every((r, i) => r.id === pageOne[i + 1]!.id),
  );

  const greedy = await listActivity(admin, { limit: MAX_PAGE_SIZE + 5000 });
  check(
    "a caller cannot argue past the page ceiling",
    greedy.length <= MAX_PAGE_SIZE,
    `got ${greedy.length}`,
  );

  const beyondTheEnd = await listActivity(admin, { limit: DEFAULT_PAGE_SIZE, offset: 1_000_000 });
  check("an offset past the end returns nothing rather than throwing", beyondTheEnd.length === 0);

  const scopedPage = await listActivity(alice, { limit: DEFAULT_PAGE_SIZE, offset: 0 });
  check(
    "paging does not widen the visibility scope",
    !scopedPage.some((r) => r.correlation_id === `${run}-b`),
  );

  // --------------------------------------------------- the pipeline list
  /**
   * The pipeline index, checked here rather than in its own script because it
   * is the same rule as everything above: who may see what.
   *
   * Worth its own assertions because the list page was the last place the
   * rule was not applied. `listProposals` has always accepted an `authorId`
   * and the page never passed one, so every salesperson could read every
   * colleague's reference, client company, status and cost from the front
   * page while the per-proposal guards refused them the proposal itself.
   */
  const alicesPipeline = await listProposals({ status: "all", authorId: alice.id });
  check(
    "a salesperson's pipeline holds their own proposal",
    alicesPipeline.some((p) => p.id === alicesProposal),
  );
  check(
    "a salesperson's pipeline does NOT hold a colleague's",
    !alicesPipeline.some((p) => p.id === bobsProposal),
  );
  check(
    "every row in a scoped pipeline belongs to that salesperson",
    alicesPipeline.every((p) => p.author_id === alice.id),
  );

  const wholeFirm = await listProposals({ status: "all" });
  check(
    "an unscoped pipeline, which is what an approver and an admin get, holds both",
    wholeFirm.some((p) => p.id === alicesProposal) && wholeFirm.some((p) => p.id === bobsProposal),
  );

  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  await closePool();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("verify:activity failed:", err instanceof Error ? err.message : err);
  await cleanup().catch(() => {});
  await closePool().catch(() => {});
  process.exit(1);
});
