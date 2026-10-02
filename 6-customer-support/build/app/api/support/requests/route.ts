import { CALLER_COOKIE, cookieFrom, readCallerCookie } from '../../../../lib/caller.ts';
import { requestsFor } from '../../../../lib/customer-requests.ts';

export const dynamic = 'force-dynamic';

/** The signed-in customer's own tickets and escalations. A guest has none to show, and gets an empty list. */
export async function GET(req: Request): Promise<Response> {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const caller = readCallerCookie(cookieFrom(req.headers.get('cookie'), CALLER_COOKIE));
  if (!caller) return new Response(JSON.stringify({ error: 'Sign in to see your requests.' }), { status: 401, headers });
  if (caller.mode !== 'customer') return new Response(JSON.stringify({ requests: [] }), { status: 200, headers });
  try {
    return new Response(JSON.stringify({ requests: await requestsFor(caller.customerId) }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Your requests could not be loaded. Try again in a moment.' }), { status: 503, headers });
  }
}
