import { NextResponse, type NextRequest } from "next/server";

/**
 * Navigation guard.
 *
 * This checks only for the PRESENCE of a session cookie, not its validity —
 * middleware runs on the edge with no database, so it cannot verify a session
 * or read a role. That is fine, because it is not the security boundary: every
 * page revalidates the session server-side and every mutating route calls
 * `requireRole`. What this buys is a fast redirect to the sign-in page instead
 * of a flash of empty layout, and a `next` parameter so the reviewer lands
 * back where they were going.
 *
 * Treating middleware as the authorisation layer is a common and serious
 * mistake — an API route reached directly would then be unprotected. The role
 * checks that matter live in lib/api.ts and lib/proposal/state.ts.
 */

export const PUBLIC_PREFIXES = [
  "/login",
  // Registration is open by necessity, and gated by the authorised-address
  // list rather than by a session. It is rate limited per IP for the same
  // reason sign-in is.
  "/register",
  "/api/register",
  "/p/", // client-facing proposal links, authenticated by their own token
  /**
   * The client's own PDF download, and it is NOT covered by "/p/".
   *
   * `"/api/p/abc/pdf".startsWith("/p/")` is false, so this route was being
   * refused with a 401 for exactly the people it exists for: a client has no
   * session. The proposal page rendered, because that really is under `/p/`,
   * and the Download PDF button on it returned a JSON error body that the
   * browser had been told to save as a file. Nothing appeared to happen.
   *
   * Listed separately rather than by loosening the pattern to `/p`, which
   * would also match any future `/private` or `/proposals`-adjacent path.
   * The route authenticates itself: it resolves the share token, re-checks
   * the approval status and the blocking-gap gate, and takes no session at
   * all. See app/api/p/[token]/pdf/route.ts.
   */
  "/api/p/",
  "/api/health",
  "/_next",
  "/favicon",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has("koya_session");
  if (hasSession) return NextResponse.next();

  // API routes get a 401 rather than a redirect: a fetch that follows a 302 to
  // an HTML sign-in page produces a JSON parse error at the call site, which
  // is a much worse error message than the real one.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Your session has expired. Sign in again to continue.",
        },
      },
      { status: 401 },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except static assets. The list above then allows the public
  // paths through, so adding a page defaults to it being protected.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
