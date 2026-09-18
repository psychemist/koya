import { NextResponse } from 'next/server';
import { cookieName, currentUser } from '@/lib/auth';
import { event } from '@/lib/audit';
import { correlationId } from '@/lib/hash';

export const dynamic = 'force-dynamic';

/**
 * Sign out.
 *
 * POST, not GET, and that is not pedantry. A GET that ends a session is
 * triggered by anything that fetches a URL: a link prefetch, a preview
 * crawler, an image tag on somebody else's page. Signing a reviewer out
 * mid-review is a small harm, but it is one any page on the internet could
 * cause.
 *
 * The session is a signed token rather than a database row, so there is
 * nothing to revoke server-side and clearing the cookie is the whole
 * operation. That is a real limitation and worth naming: a token already
 * copied out of the browser stays valid until it expires, twelve hours from
 * issue. A table of live sessions would close that, at the cost of a table
 * nothing expires from.
 */
export async function POST() {
  const cid = correlationId();

  // Read before the cookie goes, because afterwards there is no way to know
  // who it was. Sign-in is audited, so sign-out should be too.
  const user = await currentUser().catch(() => null);
  if (user) {
    await event({ correlationId: cid, actorId: user.id, stage: 'logout', outcome: 'ok' });
  }

  const res = NextResponse.json({ data: { signedOut: true } });
  res.cookies.set(cookieName, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}
