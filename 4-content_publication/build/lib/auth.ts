import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { config } from './config';
import { one } from './db';
import { Errors } from './errors';

export type Role = 'manager' | 'editor' | 'admin';

export type Session = {
  id: string;
  email: string;
  name: string;
  role: string;
  /**
   * Set only when an admin has switched into this identity for the demo. It
   * carries the admin's own user id, so the switcher stays reachable after the
   * switch and every action can still be traced back to the person who took it.
   */
  switchedFromId?: string;
};

const COOKIE = 'koya_session';
const MAX_AGE = 12 * 60 * 60; // 12 hours — a table nothing expires from is a liability

/** Signed, not encrypted. It carries no secret, only an identity claim. */
function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret()).update(payload).digest('base64url');
}

/**
 * `switchedFromId` rides inside the FIRST dot-separated field, after a `~`.
 *
 * A UUID cannot contain a `~`, so the token still splits into exactly three
 * parts on `.` and the verifier is unchanged in shape. It lives inside the
 * SIGNED payload rather than in a second cookie because an unsigned claim
 * about who you really are is not a claim, it is a suggestion: a second cookie
 * would let anyone paste an admin id beside a manager session and get the
 * switcher back.
 */
export function issue(userId: string, switchedFromId?: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `${userId}~${switchedFromId ?? ''}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string): { userId: string; switchedFromId?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [subject, exp, sig] = parts;
  const expected = sign(`${subject}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;

  const [userId, switchedFromId] = subject.split('~');
  if (!userId) return null;
  return { userId, switchedFromId: switchedFromId || undefined };
}

export async function currentUser(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const claim = verify(token);
  if (!claim) return null;
  const user = await one<Session>(
    `select id, email, name, role from public.users where id=$1`, [claim.userId]);
  if (!user) return null;
  return claim.switchedFromId ? { ...user, switchedFromId: claim.switchedFromId } : user;
}

export async function requireUser(): Promise<Session> {
  const u = await currentUser();
  if (!u) throw Errors.forbidden();
  return u;
}

/**
 * The page equivalent, and it redirects rather than throwing.
 *
 * `requireUser` raises a 404 AppError, which is right for a route handler and
 * wrong for a screen: a signed-out person following a bookmark to a request
 * got the error boundary, with no sign-in form and nothing to click. The
 * correct answer to "who are you" is the sign-in page, and `next` brings them
 * back to what they were opening once they have answered it.
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

export const cookieName = COOKIE;
export const cookieMaxAge = MAX_AGE;

/**
 * WHO IS ALLOWED TO DECIDE.
 *
 * One definition, used by the route AND by the screen, because two copies of
 * an authorisation rule drift and the screen's copy is the one people see.
 * The route is still the control: this is exported so the screen can explain
 * itself, not so the screen can enforce anything.
 *
 * All three decisions need the editor role. Sending a draft back or rejecting
 * it is an editorial act with the same standing as approving it: it stops the
 * work, it is recorded against a named person, and the author is told. A
 * manager able to reject anything an editor had not yet reached would be
 * making the editorial call without carrying the accountability for it.
 *
 * Separation of duties applies to all three for the same reason. An author
 * revising their own draft is a normal revision, not a decision; routing their
 * own work through the approvals table would leave a record saying a review
 * happened when nobody other than the author had looked at it.
 */
export function decisionRefusal(opts: {
  actorId: string;
  actorRole: string;
  requesterId: string;
  decision: 'approved' | 'changes_requested' | 'rejected';
  soloOverride?: boolean;
}): string | null {
  if (opts.soloOverride) return null;

  /*
   * SEPARATION OF DUTIES IS CHECKED FIRST, and the order is the whole point.
   *
   * Both refusals can be true at once: a manager acting on their own request
   * lacks the role AND is the author. Reporting the role first tells them to
   * go and get made an editor, which would not help, because as the author
   * they still could not decide on it. The author refusal is the one that
   * describes their actual situation, so it is the one they are told.
   */
  if (opts.actorId === opts.requesterId) {
    return 'You raised this request, so you cannot approve it. ' +
      'Someone other than the author has to sign it off or send it back.';
  }
  if (!['editor', 'admin'].includes(opts.actorRole)) {
    return opts.decision === 'approved'
      ? 'Only an editor can approve content for publication.'
      : 'Only an editor can send a draft back or reject it. Both are recorded editorial decisions.';
  }
  return null;
}

/** Engineering words become the words a person would use. */
export const roleLabel = (role: string) =>
  ({ manager: 'Manager', editor: 'Editor', admin: 'Admin' }[role]
    ?? role.charAt(0).toUpperCase() + role.slice(1));

/** scrypt, salted per user. Never a bare hash. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
