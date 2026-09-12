import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_PREFIXES } from "../../middleware";

/**
 * Which paths a person with no session may reach.
 *
 * WHY THIS TEST EXISTS. The client's PDF download lives at
 * `/api/p/<token>/pdf`, and the public list contained `/p/`. Prefix matching
 * is `startsWith`, and `"/api/p/x/pdf".startsWith("/p/")` is false, so the
 * one route that exists specifically for people without an account was
 * refused with a 401 for everyone without an account.
 *
 * It failed invisibly, which is the part worth guarding. The proposal page
 * really is under `/p/` and rendered fine, so the link looked healthy; the
 * Download PDF button returned a JSON error body that the browser had been
 * asked to save as a file, and nothing appeared to happen at all. No error,
 * no console message, nothing a client could report beyond "it does nothing".
 *
 * The two halves of the client experience are asserted together, because
 * having one without the other is exactly the state that shipped.
 */

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

test("everything a client without an account needs is public", () => {
  const token = "4A4AWlaggqXvtsbrbDNQW_Mn9uYxqHW4dntxiXbVM9Y";
  for (const path of [`/p/${token}`, `/api/p/${token}/pdf`]) {
    assert.equal(isPublic(path), true, `${path} must be reachable without a session`);
  }
});

test("sign-in, registration and the health probe are public", () => {
  for (const path of ["/login", "/register", "/api/register", "/api/health"]) {
    assert.equal(isPublic(path), true, `${path} must be public`);
  }
});

test("nothing internal is public", () => {
  const internal = [
    "/",
    "/activity",
    "/system",
    "/team",
    "/proposals/new",
    "/proposals/8f3c1d2e-0000-4000-8000-000000000001",
    "/proposals/8f3c1d2e-0000-4000-8000-000000000001/deliver",
    "/api/proposals/8f3c1d2e/send",
    "/api/proposals/8f3c1d2e/document",
    "/api/proposals/8f3c1d2e/approver",
    "/api/team/invites",
  ];
  for (const path of internal) {
    assert.equal(isPublic(path), false, `${path} must require a session`);
  }
});

test("a public prefix cannot be widened into a neighbouring path", () => {
  /**
   * The reason `/api/p/` is listed in full rather than shortening `/p/` to
   * `/p`: a looser prefix would quietly make every path that merely begins
   * with those characters public.
   */
  for (const path of ["/private", "/proposals", "/api/proposals/x/send", "/api/people"]) {
    assert.equal(isPublic(path), false, `${path} must not be caught by a client prefix`);
  }
});
