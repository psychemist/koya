import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { one, query } from './db.ts';

/**
 * Console sign-in, ported from Week 5. Roles are support_agent and admin.
 *
 * The session is read from a Cookie header string, not from next/headers, so
 * the API routes that change records can be called and tested with a plain
 * Request. Pages pass the header from cookies() (see app/console/layout.tsx).
 */
export type Role = 'support_agent' | 'admin';
export type Session = { id: string; email: string; name: string; role: Role };

export const cookieName = 'rp_console_session';
export const cookieMaxAge = 12 * 60 * 60;   // 12 hours. A session nothing expires is a liability.

/** Signed, not encrypted. The `console:` prefix keeps it apart from chat tokens signed with the same secret. */
const sign = (payload: string) => createHmac('sha256', config.web.sessionSecret).update(`console:${payload}`).digest('base64url');

export function issue(userId: string): string {
  const payload = `${userId}.${Math.floor(Date.now() / 1000) + cookieMaxAge}`;
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const a = Buffer.from(sig), b = Buffer.from(sign(`${userId}.${exp}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) * 1000 > Date.now()) || !userId) return null;
  return { userId };
}

export function sessionUserId(cookieHeader: string | null | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === cookieName) return verify(v.join('='))?.userId ?? null;
  }
  return null;
}

export async function userFromCookieHeader(cookieHeader: string | null | undefined): Promise<Session | null> {
  const id = sessionUserId(cookieHeader);
  if (!id) return null;
  return one<Session>('select id, email, name, role from public.users where id::text = $1', [id]);
}

/** For route handlers: null means answer 401. */
export const userFromRequest = (req: Request) => userFromCookieHeader(req.headers.get('cookie'));

/**
 * A change to a record is refused when it comes from another site, whatever cookie it carries.
 * Same-origin means our configured URL, or the host this request was sent to: the same server
 * reached as 127.0.0.1 or a LAN address is not another site, and a page elsewhere cannot set Host.
 */
export const foreignOrigin = (req: Request) => {
  const o = req.headers.get('origin');
  if (!o || o === config.web.baseUrl) return false;
  const host = req.headers.get('host');
  try { return !host || new URL(o).host !== host; } catch { return true; }
};

export const sessionCookie = (token: string) =>
  `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${cookieMaxAge}${config.web.baseUrl.startsWith('https://') ? '; Secure' : ''}`;
export const clearSessionCookie = () => `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export const roleLabel = (role: string) =>
  ({ support_agent: 'Support agent', admin: 'Admin' }[role] ?? role.charAt(0).toUpperCase() + role.slice(1));

/** scrypt, salted per user. Never a bare hash. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPassword(pw: string, stored: string | null): boolean {
  if (!stored || !pw) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function touchLastSeen(userId: string): Promise<void> {
  await query('update public.users set last_seen_at = now() where id = $1', [userId]).catch(() => undefined);
}
