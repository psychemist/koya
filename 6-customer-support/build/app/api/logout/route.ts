import { clearSessionCookie } from '../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
}
