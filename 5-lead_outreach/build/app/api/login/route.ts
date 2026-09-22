import { NextResponse } from 'next/server';
import { one } from '../../../lib/db.ts';
import { checkPassword, issue, cookieName, cookieMaxAge, touchLastSeen } from '../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as
    { email?: string; password?: string };

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  const user = await one<{ id: string; password_hash: string | null }>(
    'select id, password_hash from public.users where lower(email) = $1', [email]);

  // One message for both "no such account" and "wrong password". Telling the
  // difference tells an attacker which addresses exist.
  if (!user || !checkPassword(password, user.password_hash)) {
    return NextResponse.json({ error: 'That email and password do not match.' }, { status: 401 });
  }

  await touchLastSeen(user.id);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, issue(user.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: cookieMaxAge,
  });
  return res;
}
