import { one } from '../../../lib/db.ts';
import { checkPassword, foreignOrigin, issue, sessionCookie, touchLastSeen } from '../../../lib/auth.ts';
import { createLimiter } from '../../../lib/rate-limit.ts';

export const dynamic = 'force-dynamic';
const limiter = createLimiter({ perWindow: 10, windowMs: 10 * 60_000 });

export async function POST(req: Request): Promise<Response> {
  if (foreignOrigin(req)) return Response.json({ error: 'Sign in from the console.' }, { status: 403 });
  if (!limiter.take((req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'))
    return Response.json({ error: 'Too many sign-in attempts. Wait ten minutes and try again.' }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  const user = await one<{ id: string; password_hash: string | null }>('select id, password_hash from public.users where lower(email) = $1', [email]);
  // One message for both "no such account" and "wrong password": telling them apart tells an attacker which addresses exist.
  if (!user || !checkPassword(body.password ?? '', user.password_hash))
    return Response.json({ error: 'That email and password do not match.' }, { status: 401 });
  await touchLastSeen(user.id);
  return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(issue(user.id)) } });
}
