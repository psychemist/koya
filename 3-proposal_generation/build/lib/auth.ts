import { cache } from "react";
import { cookies } from "next/headers";
import { query, queryOne } from "./db";
import { generateToken, hmacHex, verifyPassword } from "./crypto";
import { AppError, ErrorCode, errors } from "./errors";

/**
 * Server-side sessions, not stateless JWTs.
 *
 * A signed token that carries its own claims cannot be revoked before it
 * expires. Approval authority is the thing being carried here, so being able
 * to end a session immediately — a laptop left on a train, a role changed,
 * a reviewer who has left — is worth one indexed lookup per request.
 *
 * What the cookie holds is 32 bytes of CSPRNG output. What the database holds
 * is HMAC-SHA256(APP_SESSION_SECRET, token). Two consequences, both wanted:
 * a database dump contains no usable session, and rotating the secret ends
 * every session at once without touching a row.
 */

const COOKIE_NAME = "koya_session";
const SESSION_TTL_HOURS = 12;

export type Role = "salesperson" | "approver" | "admin";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
};

function sessionSecret(): string {
  const secret = process.env.APP_SESSION_SECRET;
  // Failing loudly beats defaulting to a well-known value. A development
  // fallback here would be a hardcoded credential that ships to production the
  // first time someone forgets an environment variable.
  if (!secret || secret.length < 32) {
    throw new Error(
      "APP_SESSION_SECRET is missing or shorter than 32 characters. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return secret;
}

function sessionKey(token: string): string {
  return hmacHex(sessionSecret(), token);
}

/**
 * Verifies credentials and opens a session. Returns the user.
 *
 * Both "no such account" and "wrong password" produce the identical
 * BAD_CREDENTIALS error, and the no-such-account path still runs a password
 * verification against a dummy hash. Without that, response timing tells an
 * attacker which addresses are real.
 */
export async function signIn(
  email: string,
  password: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<User> {
  const normalised = email.trim().toLowerCase();

  const row = await queryOne<User & { password_hash: string }>(
    `SELECT id, email, name, role, is_active, password_hash
       FROM users WHERE lower(email) = $1`,
    [normalised],
  );

  const ok = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyPassword(password, DUMMY_HASH);

  if (!row || !ok) {
    throw new AppError({
      code: ErrorCode.BAD_CREDENTIALS,
      userMessage: "That email and password do not match an account.",
      detail: { email: normalised, reason: row ? "bad_password" : "no_such_user" },
    });
  }

  if (!row.is_active) {
    throw new AppError({
      code: ErrorCode.FORBIDDEN_ROLE,
      userMessage: "This account has been deactivated. Ask an administrator to re-enable it.",
      detail: { email: normalised },
    });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000);

  await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionKey(token), row.id, expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, // no JavaScript can read it, so XSS cannot exfiltrate it
    sameSite: "lax", // survives the click-through from an email link
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  return { id: row.id, email: row.email, name: row.name, role: row.role, is_active: true };
}

/**
 * A real scrypt hash of a random string, used only to burn the same CPU time
 * on the no-such-user path as on a genuine verification.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$PLPu4KL3EGtKFojWqCCQFw==$btKn7i/UqC8Rc8Ix68dLbM1D/ips00BALFRR5Jaf2qE=";

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    // Delete the row, not just the cookie: a cookie the browser still holds
    // must stop working server-side too.
    await query("DELETE FROM sessions WHERE id = $1", [sessionKey(token)]);
  }
  jar.delete(COOKIE_NAME);
}

/**
 * The current user, or null. Wrapped in React's `cache` so that a page which
 * checks the user in a layout, a page component and three server components
 * performs one query per request rather than five.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  let token: string | undefined;
  try {
    token = (await cookies()).get(COOKIE_NAME)?.value;
  } catch {
    // `cookies()` throws outside a request scope. Treat it as signed out.
    return null;
  }
  if (!token) return null;

  const row = await queryOne<User & { expires_at: Date }>(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [sessionKey(token)],
  );

  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) {
    await query("DELETE FROM sessions WHERE id = $1", [sessionKey(token)]);
    return null;
  }
  // A deactivated user's existing session stops working immediately.
  if (!row.is_active) return null;

  return { id: row.id, email: row.email, name: row.name, role: row.role, is_active: true };
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw errors.unauthenticated();
  return user;
}

/**
 * Role gate. Called inside every mutating route handler rather than only in
 * middleware: middleware protects navigation, but an API route reached
 * directly with a valid cookie and the wrong role has to be refused by the
 * route itself. Admin passes every check.
 */
export async function requireRole(...allowed: Role[]): Promise<User> {
  const user = await requireUser();
  if (user.role === "admin" || allowed.includes(user.role)) return user;
  throw errors.forbiddenRole(allowed.join(" or "), user.role);
}

/** Best-effort housekeeping, called from the health endpoint. */
export async function pruneExpiredSessions(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH gone AS (DELETE FROM sessions WHERE expires_at < now() RETURNING 1)
     SELECT count(*)::text AS count FROM gone`,
  );
  return Number(rows[0]?.count ?? 0);
}
