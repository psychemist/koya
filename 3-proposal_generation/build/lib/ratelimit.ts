import { queryOne } from "./db";
import { sha256Hex } from "./crypto";
import { AppError, ErrorCode } from "./errors";

/**
 * Rate limiting, in Postgres.
 *
 * Two things in this application are expensive in a way an ordinary bug is
 * not, and neither had a ceiling before this module:
 *
 *   Money. `POST /api/proposals/[id]/generate` is a full Opus draft and
 *   `POST .../sections/[key]` is a section regeneration. Both are paid calls
 *   fired by an authenticated click. A held-down key, a retry loop in someone's
 *   script, or one careless colleague is unbounded spend against a key with no
 *   per-request cap. Prompt caching lowers the unit price; it does not bound
 *   the number of units.
 *
 *   CPU. Sign-in runs scrypt at N=16384, which is 16 MB and something like
 *   80 ms of deliberate work — the property that makes offline guessing
 *   expensive. It also makes sign-in an amplifier: a cheap request costs the
 *   server dearly, and the timing-attack defence means the no-such-user path
 *   burns exactly as much. Unlimited sign-in attempts are therefore both a
 *   password-guessing oracle and a denial-of-service primitive, and the
 *   hardening that closed the first opened the second.
 *
 * Why the counter lives in the database is argued in 003_rate_limits.sql: a
 * module-scope Map limits one serverless instance, not one deployment.
 *
 * FAILURE POSTURE — FAIL OPEN, LOUDLY. If the limiter's own query fails, the
 * request proceeds and the failure is announced on stderr. This is a
 * judgement, not an oversight: the limiter is a guard rail, and a guard rail
 * whose malfunction stops every sign-in has caused a worse outage than the
 * abuse it exists to prevent. Callers that would rather fail closed pass
 * `failOpen: false` and handle the throw.
 */

export type Limit = {
  /** What is being limited. Part of the bucket key, so scopes never collide. */
  scope: string;
  /** Requests permitted per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/** The limits this application enforces, in one place so they can be read off. */
export const LIMITS = {
  /**
   * Per account. Six full drafts an hour is far more than the working pattern
   * — a salesperson writes a proposal, then revises sections — and far less
   * than a loop.
   */
  generate: { scope: "proposal.generate", max: 6, windowSeconds: 3600 },

  /** Regeneration is the iterative one, so the ceiling is higher. */
  regenerate: { scope: "section.regenerate", max: 40, windowSeconds: 3600 },

  /**
   * Per email address. Ten attempts in fifteen minutes stops guessing without
   * locking out someone with a genuinely forgotten password.
   */
  loginByEmail: { scope: "auth.login.email", max: 10, windowSeconds: 900 },

  /**
   * Per source address, and deliberately looser than the per-email limit: an
   * office behind one NAT address is many legitimate people. This one is aimed
   * at the CPU-exhaustion case, where the attacker varies the email precisely
   * to slip past a per-email counter.
   */
  loginByIp: { scope: "auth.login.ip", max: 40, windowSeconds: 900 },
} as const satisfies Record<string, Limit>;

export type LimitVerdict = {
  allowed: boolean;
  /** Attempts left in this window after the one just counted. */
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
};

export function bucketFor(
  limit: Limit,
  subject: string,
  now: number,
): { bucket: string; start: Date } {
  const windowMs = limit.windowSeconds * 1000;
  // Flooring to the window makes the key deterministic, so every instance
  // handling a concurrent request computes the same row to contend on.
  const startMs = Math.floor(now / windowMs) * windowMs;
  return {
    bucket: sha256Hex(`${limit.scope} ${subject} ${startMs}`),
    start: new Date(startMs),
  };
}

/**
 * Counts one request against `limit` and says whether it may proceed.
 *
 * The increment and the read are a single statement. Doing it as SELECT then
 * UPDATE would let two concurrent requests both read `max - 1` and both
 * proceed, which is the specific race a limiter exists to lose gracefully — so
 * the upsert returns the post-increment count and the decision is made on that.
 */
export async function consume(
  limit: Limit,
  subject: string,
  opts: { failOpen?: boolean } = {},
): Promise<LimitVerdict> {
  const now = Date.now();
  const { bucket, start } = bucketFor(limit, subject, now);
  const expires = new Date(start.getTime() + limit.windowSeconds * 1000);
  const resetSeconds = Math.max(1, Math.ceil((expires.getTime() - now) / 1000));

  try {
    const row = await queryOne<{ count: number }>(
      `INSERT INTO rate_limits (bucket, scope, count, window_start, expires_at)
            VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (bucket)
       DO UPDATE SET count = rate_limits.count + 1
         RETURNING count`,
      [bucket, limit.scope, start, expires],
    );

    const count = row?.count ?? 1;
    return {
      allowed: count <= limit.max,
      remaining: Math.max(0, limit.max - count),
      resetSeconds,
    };
  } catch (err) {
    if (opts.failOpen === false) throw err;
    // Announced, never silent. See the failure posture note above.
    console.error(
      JSON.stringify({
        level: "error",
        scope: "ratelimit.unavailable",
        limit: limit.scope,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return { allowed: true, remaining: limit.max, resetSeconds };
  }
}

/** `consume`, but throws the 429 when the verdict is no. */
export async function enforce(limit: Limit, subject: string, userMessage: string): Promise<void> {
  const verdict = await consume(limit, subject);
  if (verdict.allowed) return;

  throw new AppError({
    code: ErrorCode.RATE_LIMITED,
    httpStatus: 429,
    userMessage: `${userMessage} Try again in ${describe(verdict.resetSeconds)}.`,
    message: `rate limit ${limit.scope} exceeded (max ${limit.max}/${limit.windowSeconds}s)`,
    detail: { limit: limit.scope, max: limit.max, resetSeconds: verdict.resetSeconds },
    retryable: true,
  });
}

export function describe(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Housekeeping, called from the health endpoint alongside the session prune. */
export async function pruneExpiredLimits(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `WITH gone AS (DELETE FROM rate_limits WHERE expires_at < now() RETURNING 1)
     SELECT count(*)::text AS count FROM gone`,
  );
  return Number(row?.count ?? 0);
}

/**
 * The client's address, as well as it can be known behind a proxy.
 *
 * `x-forwarded-for` is client-controllable in general, which is why this takes
 * the LEFTMOST entry only as a hint and never as an identity. It gates nothing
 * that matters on its own — an attacker who rotates it defeats the per-IP
 * login limit and still meets the per-email one, which is the limit that
 * actually protects an account.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}
