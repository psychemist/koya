import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { config } from './config.ts';
import { one, query } from './db.ts';

export type Role = 'operator' | 'admin';

export type Session = { id: string; email: string; name: string; role: Role };

const COOKIE = 'koya_lead_session';
const MAX_AGE = 12 * 60 * 60;   // 12 hours. A session nothing expires is a liability.

/** Signed, not encrypted. It carries no secret, only an identity claim. */
function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret()).update(payload).digest('base64url');
}

export function issue(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = sign(`${userId}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  if (!userId) return null;
  return { userId };
}

export async function currentUser(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const claim = verify(token);
  if (!claim) return null;
  return one<Session>(
    'select id, email, name, role from public.users where id = $1', [claim.userId]);
}

/** For route handlers. Returns null and the caller answers 401. */
export async function requireUser(): Promise<Session | null> {
  return currentUser();
}

/**
 * The page equivalent, and it redirects rather than throwing.
 *
 * The correct answer to "who are you" is the sign-in page, not an error
 * boundary, and `next` brings a person back to what they were opening once
 * they have answered it.
 */
export async function requireUserPage(next?: string): Promise<Session> {
  const u = await currentUser();
  if (!u) {
    redirect(next && next.startsWith('/') && !next.startsWith('//')
      ? `/?next=${encodeURIComponent(next)}`
      : '/');
  }
  return u;
}

export async function requireAdminPage(next?: string): Promise<Session> {
  const u = await requireUserPage(next);
  if (u.role !== 'admin') redirect('/');
  return u;
}

export const cookieName = COOKIE;
export const cookieMaxAge = MAX_AGE;

/**
 * WHO IS ALLOWED TO SEE A RUN.
 *
 * One definition, used by the routes AND by the screens, because two copies of
 * an authorisation rule drift and the screen's copy is the one people see.
 *
 * An operator sees the runs they started. An admin sees everything, because
 * the admin is the person answerable for a shared budget and cannot audit
 * spend they are not allowed to look at.
 */
export function canSeeRun(user: Session, run: { created_by: string | null }): boolean {
  return user.role === 'admin' || run.created_by === user.id;
}

/**
 * Deleting a run destroys its evidence, so it is narrower than seeing one:
 * the person who started it, or an admin. An unowned run left over from
 * before accounts existed is admin-only, because nobody can claim it.
 */
export function canDeleteRun(user: Session, run: { created_by: string | null }): boolean {
  return user.role === 'admin' || (run.created_by !== null && run.created_by === user.id);
}

export const roleLabel = (role: string) =>
  ({ operator: 'Operator', admin: 'Admin' }[role]
    ?? role.charAt(0).toUpperCase() + role.slice(1));

/** scrypt, salted per user. Never a bare hash. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function touchLastSeen(userId: string): Promise<void> {
  await query('update public.users set last_seen_at = now() where id = $1', [userId])
    .catch(() => undefined);
}
