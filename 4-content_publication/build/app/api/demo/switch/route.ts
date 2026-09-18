import { z } from 'zod';
import { NextResponse } from 'next/server';
import { one } from '@/lib/db';
import { currentUser, issue, cookieName, cookieMaxAge } from '@/lib/auth';
import { config } from '@/lib/config';
import { event } from '@/lib/audit';
import { correlationId } from '@/lib/hash';

export const dynamic = 'force-dynamic';

const Body = z.object({ role: z.enum(['manager', 'editor', 'admin']) });

/**
 * The demo role switcher.
 *
 * It does NOT change your role. It signs you in as a different PERSON: the
 * seeded manager or the seeded editor, each a real row with its own id. That
 * distinction is the whole design.
 *
 * A switcher that flipped a role string on one account would quietly dismantle
 * the control this project is built to demonstrate. `approve` refuses when
 * `requester_id = actor_id`, so one account wearing two hats would either
 * approve its own work or be unable to approve anything at all, and whichever
 * of those happened, the gate on screen would no longer be the gate in the
 * database. Switching identity keeps both true at once: the demo flows, and
 * the request raised by Ada genuinely cannot be signed off by Ada.
 *
 * Who may call it: an admin, or a session that STARTED as an admin and has
 * since switched. The second case is what makes the switch reversible, and it
 * is carried in the signed token rather than in a cookie of its own.
 */
export async function POST(req: Request) {
  const cid = correlationId();

  if (!config.demoRoleSwitch) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Not found.', correlationId: cid } },
      { status: 404 });
  }

  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Not found.', correlationId: cid } },
      { status: 404 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Pick a role to view as.', correlationId: cid } },
      { status: 422 });
  }

  // The admin behind this session. Either you ARE the admin, or you are an
  // identity an admin switched into. Re-read the row rather than trusting the
  // token's word for it: the account could have been demoted since the token
  // was signed, and a 12-hour session is long enough for that to matter.
  const adminId = me.role === 'admin' ? me.id : me.switchedFromId;
  const admin = adminId
    ? await one<{ id: string; name: string; role: string }>(
        `select id, name, role from public.users where id=$1`, [adminId])
    : null;

  if (!admin || admin.role !== 'admin') {
    await event({ correlationId: cid, actorId: me.id, stage: 'demo.switch', outcome: 'blocked',
      detail: { requested: parsed.data.role, reason: 'not an admin session' } });
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Not found.', correlationId: cid } },
      { status: 404 });
  }

  // Oldest account for the role, so the target is stable across re-seeds
  // rather than whichever row the planner happened to return first.
  const target = parsed.data.role === 'admin'
    ? admin
    : await one<{ id: string; name: string; role: string }>(
        `select id, name, role from public.users
          where role=$1 and password_hash is not null
          order by created_at asc limit 1`, [parsed.data.role]);

  if (!target) {
    return NextResponse.json(
      { error: { code: 'not_found',
                 message: `No seeded ${parsed.data.role} account exists. Run npm run seed.`,
                 correlationId: cid } },
      { status: 404 });
  }

  await event({
    correlationId: cid, actorId: admin.id, stage: 'demo.switch', outcome: 'ok',
    detail: { from: me.id, to: target.id, role: target.role },
  });

  const res = NextResponse.json({ data: { name: target.name, role: target.role } });
  res.cookies.set(
    cookieName,
    // Switching back to the admin clears the marker: you are simply yourself
    // again, and a session claiming to be switched into its own identity is a
    // loose end waiting to confuse the next reader of the audit log.
    issue(target.id, target.id === admin.id ? undefined : admin.id),
    {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', maxAge: cookieMaxAge,
    },
  );
  return res;
}
