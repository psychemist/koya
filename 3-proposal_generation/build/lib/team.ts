import { query, queryOne } from "./db";
import { AppError, ErrorCode, errors } from "./errors";
import { hashPassword } from "./crypto";
import type { Role, User } from "./auth";

/**
 * Team membership and the invite allow-list.
 *
 * Until this existed, accounts came from a seed script. That is fine for one
 * developer and unworkable for a sales team: there was no way to add a
 * colleague, no way to say who may approve, and no way to remove somebody who
 * had left — which matters more here than in most applications, because the
 * single control this whole system rests on is that a DIFFERENT person
 * approves a proposal before it reaches a client. An approver list that
 * cannot be changed is an approval step that decays into whoever happened to
 * be seeded.
 *
 * THE GUARDS ARE THE INTERESTING PART. Three of them, each closing a way an
 * administrator can lock the organisation out of its own controls:
 *
 *   Nobody changes their own role. A salesperson who could promote themselves
 *   to approver could approve their own proposals, which is the one thing the
 *   status machine exists to prevent. An administrator demoting themselves by
 *   accident is the same bug from the other side.
 *
 *   The last active administrator cannot be demoted or deactivated. Otherwise
 *   the final admin action anybody can take is the one that makes every
 *   further admin action impossible.
 *
 *   Deactivating somebody does not delete them. Their name stays on the
 *   proposals they wrote and the approvals they gave; an audit trail that
 *   loses its actors when they leave is not an audit trail.
 */

export type Member = {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
  /** Proposals authored. Shown so deactivation is an informed decision. */
  authored: number;
  approvals: number;
};

export type Invite = {
  id: string;
  email: string;
  role: Role;
  note: string | null;
  created_at: Date;
  invited_by_name: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
};

export const ROLES: Role[] = ["salesperson", "approver", "admin"];

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

/**
 * Normalises an address for storage and comparison.
 *
 * Lowercased only. Deliberately NOT stripping dots or `+tags`: those rules
 * are Gmail's, not the internet's, and applying them would silently merge two
 * genuinely different mailboxes at another provider — which for an
 * authorisation list means granting access to an address nobody approved.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function assertEmail(email: string): string {
  const value = normaliseEmail(email);
  if (!EMAIL.test(value) || value.length > 254) {
    throw errors.validation(`"${email}" is not an email address this can send to.`);
  }
  return value;
}

// ------------------------------------------------------------------ members

export async function listMembers(): Promise<Member[]> {
  return query<Member>(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, u.created_at,
            (SELECT count(*) FROM proposals p WHERE p.author_id = u.id)::int AS authored,
            (SELECT count(*) FROM approvals a WHERE a.actor_id = u.id)::int AS approvals
       FROM users u
      ORDER BY u.is_active DESC, u.role, lower(u.name)`,
  );
}

async function activeAdminCount(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active",
  );
  return row?.n ?? 0;
}

async function memberOrThrow(id: string): Promise<Member> {
  const row = await queryOne<Member>(
    `SELECT id, email, name, role, is_active, created_at, 0 AS authored, 0 AS approvals
       FROM users WHERE id = $1`,
    [id],
  );
  if (!row) throw errors.notFound("That team member");
  return row;
}

export async function setRole(args: {
  actor: User;
  userId: string;
  role: Role;
}): Promise<Member> {
  if (args.actor.id === args.userId) {
    throw errors.validation(
      "You cannot change your own role. Ask another administrator to do it, so that no single account can grant itself approval authority.",
    );
  }
  const target = await memberOrThrow(args.userId);
  if (target.role === args.role) return target;

  if (target.role === "admin" && target.is_active && (await activeAdminCount()) <= 1) {
    throw errors.validation(
      "This is the only active administrator. Promote somebody else first, or there will be no account left that can manage the team.",
    );
  }

  await query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", [
    args.userId,
    args.role,
  ]);

  /**
   * Every session the person holds is ended.
   *
   * A role is read from the `users` row on each request, so a demotion takes
   * effect immediately for authorisation. Ending their sessions anyway means
   * the interface they are looking at is rebuilt for the role they now hold,
   * rather than continuing to offer buttons that will start failing.
   */
  await query("DELETE FROM sessions WHERE user_id = $1", [args.userId]);

  return memberOrThrow(args.userId);
}

export async function setActive(args: {
  actor: User;
  userId: string;
  active: boolean;
}): Promise<Member> {
  if (args.actor.id === args.userId) {
    throw errors.validation("You cannot deactivate your own account.");
  }
  const target = await memberOrThrow(args.userId);
  if (target.is_active === args.active) return target;

  if (!args.active && target.role === "admin" && (await activeAdminCount()) <= 1) {
    throw errors.validation(
      "This is the only active administrator. Promote somebody else before deactivating them.",
    );
  }

  await query("UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1", [
    args.userId,
    args.active,
  ]);
  if (!args.active) {
    await query("DELETE FROM sessions WHERE user_id = $1", [args.userId]);
  }
  return memberOrThrow(args.userId);
}

// ------------------------------------------------------------------ invites

export async function listInvites(): Promise<Invite[]> {
  return query<Invite>(
    `SELECT i.id, i.email, i.role, i.note, i.created_at, i.accepted_at, i.revoked_at,
            u.name AS invited_by_name
       FROM team_invites i
       LEFT JOIN users u ON u.id = i.invited_by
      ORDER BY (i.accepted_at IS NULL AND i.revoked_at IS NULL) DESC, i.created_at DESC
      LIMIT 200`,
  );
}

export async function invite(args: {
  actor: User;
  email: string;
  role: Role;
  note?: string | null;
}): Promise<Invite> {
  const email = assertEmail(args.email);

  const existing = await queryOne<{ id: string; is_active: boolean }>(
    "SELECT id, is_active FROM users WHERE lower(email) = $1",
    [email],
  );
  if (existing) {
    throw errors.validation(
      existing.is_active
        ? `${email} already has an account. Change their role from the members list instead.`
        : `${email} has a deactivated account. Reactivate it rather than inviting the address again, so their history stays attached to it.`,
    );
  }

  const live = await queryOne<{ id: string }>(
    `SELECT id FROM team_invites
      WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [email],
  );
  if (live) throw errors.validation(`${email} is already on the list.`);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO team_invites (email, role, invited_by, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [email, args.role, args.actor.id, args.note?.trim() || null],
  );
  if (!row) {
    throw new AppError({
      code: ErrorCode.INTERNAL,
      userMessage: "The invitation could not be recorded.",
      message: "team_invites insert returned no row",
    });
  }

  const created = (await listInvites()).find((i) => i.id === row.id);
  if (!created) {
    throw new AppError({
      code: ErrorCode.INTERNAL,
      userMessage: "The invitation was saved but could not be read back.",
      message: "team_invites row missing immediately after insert",
    });
  }
  return created;
}

export async function revokeInvite(args: { actor: User; inviteId: string }): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `UPDATE team_invites
        SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [args.inviteId, args.actor.id],
  );
  if (!row) throw errors.notFound("That invitation");
}

// ------------------------------------------------------------- registration

/**
 * Turns an invite into an account.
 *
 * The role comes from the invite row and nowhere else. The registration form
 * has no role field, because a form that had one would let anybody holding
 * any invite register as an administrator.
 *
 * The failure message never distinguishes "no invite for this address" from
 * "this address already registered". The registration page is reachable
 * without signing in, so a distinguishing message would turn it into a way to
 * test which addresses at a company have been authorised.
 */
export async function registerFromInvite(args: {
  email: string;
  name: string;
  password: string;
}): Promise<{ userId: string }> {
  const email = normaliseEmail(args.email);
  const name = args.name.trim();

  if (name.length < 2 || name.length > 120) {
    throw errors.validation("Please give the name colleagues will see on your proposals.");
  }
  if (args.password.length < 12 || args.password.length > 200) {
    throw errors.validation("Choose a password of at least 12 characters.");
  }

  const pending = await queryOne<{ id: string; role: Role }>(
    `SELECT id, role FROM team_invites
      WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  if (!pending) {
    throw errors.validation(
      "That address cannot register. Ask an administrator to add it to the team list.",
    );
  }

  const hash = await hashPassword(args.password);

  const user = await queryOne<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING id`,
    [email, name, pending.role, hash],
  );
  if (!user) {
    // Someone registered this address between the check and the insert.
    throw errors.validation(
      "That address cannot register. Ask an administrator to add it to the team list.",
    );
  }

  await query(
    "UPDATE team_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1",
    [pending.id, user.id],
  );

  return { userId: user.id };
}
