import { CALLER_COOKIE, cookieFrom, issueCallToken, readCallerCookie } from '../../../../lib/caller.ts';

export const dynamic = 'force-dynamic';

/**
 * A ten-minute token for one web call, so the agent knows who is calling
 * without asking. Only the httpOnly cookie can mint one, and it is a separate
 * kind of signature, so the token cannot be turned back into a cookie.
 */
export async function GET(req: Request): Promise<Response> {
  const caller = readCallerCookie(cookieFrom(req.headers.get('cookie'), CALLER_COOKIE));
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (!caller) return new Response(JSON.stringify({ error: 'Sign in or continue as a guest first.' }), { status: 401, headers });
  return new Response(JSON.stringify({ token: issueCallToken(caller) }), { status: 200, headers });
}
