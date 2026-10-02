import { config } from '../../../../lib/config.ts';
import { foreignOrigin } from '../../../../lib/auth.ts';
import { one } from '../../../../lib/db.ts';
import { normalizeRef } from '../../../../lib/refs.ts';
import { createLimiter } from '../../../../lib/rate-limit.ts';
import { endAgentChat } from '../../../../lib/agent-client.ts';
import { callerCookie, clearCallerCookie, cookieFrom, issueCallerCookie } from '../../../../lib/caller.ts';
import { CHAT_COOKIE, clearChatCookie, readChatToken } from '../../../../lib/chat-session.ts';

export const dynamic = 'force-dynamic';

// Ten tries in ten minutes per address: enough for typos, too few to walk customer IDs.
const limiter = createLimiter({ perWindow: 10, windowMs: 10 * 60_000 });
const NO_MATCH = 'Those details do not match an account. Check the email and customer ID, or continue as a guest.';
const secure = () => config.web.baseUrl.startsWith('https://');
const ipOf = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';

/** Every response that changes who is on the page also drops the chat, so one person never sees another's conversation. */
async function respond(req: Request, status: number, body: object | null, caller: string): Promise<Response> {
  const chat = readChatToken(cookieFrom(req.headers.get('cookie'), CHAT_COOKIE));
  if (chat) await endAgentChat(chat, 'caller-changed');
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (body) headers.set('content-type', 'application/json');
  headers.append('set-cookie', caller);
  headers.append('set-cookie', clearChatCookie(secure()));
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}
const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Sign in as a customer (account email and customer ID, which must belong to
 * one account) or continue as a guest. The answer to a wrong pair never says
 * which half was wrong.
 */
export async function POST(req: Request): Promise<Response> {
  if (foreignOrigin(req)) return json(403, { error: 'Sign in from the RelayPay support page.' });
  const b = (await req.json().catch(() => ({}))) as { mode?: unknown; email?: unknown; customer_id?: unknown };
  if (b.mode === 'guest') return respond(req, 200, { mode: 'guest' }, callerCookie(issueCallerCookie({ mode: 'guest' }), secure()));
  if (b.mode !== 'customer') return json(400, { error: 'Choose to sign in or to continue as a guest.' });

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 200) : '';
  const customerId = typeof b.customer_id === 'string' ? normalizeRef(b.customer_id.slice(0, 40), 'CUS') : null;
  if (!email || !customerId) return json(400, { error: 'Enter the email on your RelayPay account and your customer ID.' });
  if (!limiter.take(ipOf(req))) return json(429, { error: 'Too many sign-in attempts. Wait ten minutes, or continue as a guest.' });

  let c: { customer_id: string; contact_name: string } | null;
  try {
    c = await one('select customer_id, contact_name from public.customers where email_key = $1 and customer_id = $2', [email, customerId]);
  } catch { return json(503, { error: 'Sign in is unavailable right now. Try again in a few minutes, or continue as a guest.' }); }
  if (!c) return json(401, { error: NO_MATCH });
  return respond(req, 200, { mode: 'customer', first_name: c.contact_name.split(/\s+/)[0] },
    callerCookie(issueCallerCookie({ mode: 'customer', customerId: c.customer_id }), secure()));
}

/** Sign out: ends the chat, forgets the caller. */
export async function DELETE(req: Request): Promise<Response> {
  if (foreignOrigin(req)) return json(403, { error: 'Sign out from the RelayPay support page.' });
  return respond(req, 204, null, clearCallerCookie(secure()));
}
