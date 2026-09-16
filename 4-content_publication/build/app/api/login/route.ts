import { z } from 'zod';
import { NextResponse } from 'next/server';
import { one } from '@/lib/db';
import { checkPassword, issue, cookieName, cookieMaxAge } from '@/lib/auth';
import { event } from '@/lib/audit';
import { correlationId } from '@/lib/hash';

export const dynamic = 'force-dynamic';

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const cid = correlationId();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'validation_failed', message: 'Enter an email and password.' } }, { status: 422 });
  }

  const user = await one<{ id: string; password_hash: string | null; name: string; role: string }>(
    `select id, password_hash, name, role from public.users where lower(email)=lower($1)`,
    [parsed.data.email]);

  // Same message and same shape whether the account is missing or the password
  // is wrong: distinguishing them enumerates accounts.
  const ok = user?.password_hash && checkPassword(parsed.data.password, user.password_hash);
  if (!ok) {
    await event({ correlationId: cid, stage: 'login', outcome: 'failed',
      detail: { email: parsed.data.email } });
    return NextResponse.json(
      { error: { code: 'invalid_credentials', message: 'That email and password do not match.' } },
      { status: 401 });
  }

  await event({ correlationId: cid, actorId: user!.id, stage: 'login', outcome: 'ok' });
  const res = NextResponse.json({ data: { name: user!.name, role: user!.role } });
  res.cookies.set(cookieName, issue(user!.id), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    path: '/', maxAge: cookieMaxAge,
  });
  return res;
}
