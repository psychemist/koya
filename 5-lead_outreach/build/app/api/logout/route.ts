import { NextResponse } from 'next/server';
import { cookieName } from '../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, '', { path: '/', maxAge: 0 });
  return res;
}
