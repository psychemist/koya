/**
 * Pure, dependency-free hashing and canonical serialisation.
 *
 * This module exists because of a bundling constraint that turns out to be a
 * useful design pressure. `lib/crypto.ts` imports `node:crypto`, and anything
 * reachable from a client component that touches a `node:` import fails the
 * browser build outright. The intake validator IS wanted on the client — live
 * gap feedback as a salesperson types is worth having, and it costs nothing
 * because the checks are pure rules.
 *
 * So the split is by requirement, not by convenience:
 *
 *   stableHash    — a dedupe key for gap fingerprints. Needs to be stable and
 *                   well-distributed. Does NOT need to be cryptographic:
 *                   nothing is authenticated by it, and a collision would
 *                   merge two identical-looking gaps, not leak anything.
 *   sha256Hex     — content addressing and token hashing, in lib/crypto.ts.
 *                   Stays cryptographic, stays server-only.
 *
 * Reaching for SHA-256 here would have forced the validator to be server-only
 * for no security benefit.
 */

/**
 * FNV-1a, 32 bits, doubled with a second offset basis to give 64 bits of
 * output. Fast, allocation-free, and well-distributed for short strings.
 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    // Multiply by the FNV prime using shifts, so the result stays in 32 bits
    // without relying on Math.imul's availability.
    h1 = (h1 + (h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24)) >>> 0;
    h2 ^= (c + i) & 0xff;
    h2 = (h2 + (h2 << 1) + (h2 << 4) + (h2 << 7) + (h2 << 8) + (h2 << 24)) >>> 0;
  }

  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Canonical JSON: object keys sorted recursively, so two structurally equal
 * values always serialise to the same bytes.
 *
 * `JSON.stringify` preserves insertion order, so an intake object rebuilt with
 * its fields in a different order would serialise differently and hash
 * differently — which for a cache key means paying for a request that produces
 * byte-identical output. Undefined values are dropped rather than becoming
 * null, so an absent field and an explicitly-undefined one agree.
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
