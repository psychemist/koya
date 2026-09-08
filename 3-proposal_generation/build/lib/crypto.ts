import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * `promisify` resolves to node:crypto's four-argument scrypt overload, which
 * has no options parameter — so the cost parameters would be silently dropped
 * and every hash computed at Node's defaults. The explicit signature keeps the
 * options argument, and the return type keeps callers from having to cast.
 */
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from node:crypto.
 *
 * Deliberately not argon2. The argon2 packages are native modules, and a
 * native module is one more thing that can fail to build for the deployment
 * target's exact Node version and libc — a failure that surfaces as a broken
 * production sign-in, not as a build error. scrypt is memory-hard, is a
 * recognised password KDF (RFC 7914), and ships inside Node itself, so there
 * is nothing to compile and nothing to go wrong on a cold start.
 *
 * N = 2^14 with r = 8 needs 128 * N * r = 16 MB per hash and lands around
 * 60-100 ms on the deployment target: slow enough to make offline guessing
 * expensive, fast enough that a sign-in does not time out.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = (await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }));
  // Parameters travel with the hash so they can be raised later without
  // invalidating existing passwords: verify reads N/r/p from the stored string.
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");

  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  // A hostile or corrupted hash string could otherwise ask for gigabytes of
  // memory and take the process down — a denial of service via the password
  // field. Cap what we are willing to spend verifying.
  if (N > 1 << 20 || r > 32 || p > 16 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = (await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    }));
  } catch {
    return false;
  }
  // Constant-time: a length-dependent or early-exit comparison leaks how much
  // of a guess was correct.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A URL-safe opaque token. Used for session cookies and client-facing proposal
 * links. 32 bytes of CSPRNG output — not guessable, and short enough to sit in
 * a URL a client is emailed.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * What gets stored for a token. Tokens are secrets that live in cookies and
 * URLs; the database keeps only this digest, so a database dump does not hand
 * over live sessions or live proposal links. A single SHA-256 (not a slow KDF)
 * is right here: the input is 256 bits of randomness, so there is no
 * dictionary to run against it.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** HMAC-SHA256, hex. Signs the outbound n8n webhook. */
export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Constant-time string compare for signatures and tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Canonical JSON: object keys sorted recursively, so two structurally equal
 * values always serialise to the same bytes.
 *
 * This is what makes content hashing trustworthy. `JSON.stringify` preserves
 * insertion order, so an intake object rebuilt with its fields in a different
 * order would hash differently, miss the generation cache, and pay for a
 * request that produces byte-identical output. Undefined values are dropped
 * rather than becoming null, so an absent field and an explicitly-undefined
 * one agree.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] !== undefined) out[key] = canonicalise(src[key]);
  }
  return out;
}
