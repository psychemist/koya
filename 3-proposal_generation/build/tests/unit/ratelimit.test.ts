import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LIMITS, bucketFor, describe } from "../../lib/ratelimit";

/**
 * The pure half of the limiter. `consume` needs Postgres and is covered in the
 * e2e suite, including the concurrency case that is the whole reason the
 * counter lives in the database rather than in a Map.
 */

const LIMIT = { scope: "test", max: 5, windowSeconds: 60 };

test("the same subject and window produce the same bucket", () => {
  // This is what lets two concurrent requests on different serverless
  // instances contend on one row instead of counting separately.
  const a = bucketFor(LIMIT, "user-1", 1_000_000_000_000);
  const b = bucketFor(LIMIT, "user-1", 1_000_000_000_000 + 5_000);
  assert.equal(a.bucket, b.bucket);
  assert.equal(a.start.getTime(), b.start.getTime());
});

test("different subjects never share a bucket", () => {
  const a = bucketFor(LIMIT, "user-1", 1_000_000_000_000);
  const b = bucketFor(LIMIT, "user-2", 1_000_000_000_000);
  assert.notEqual(a.bucket, b.bucket);
});

test("different scopes never share a bucket", () => {
  const now = 1_000_000_000_000;
  const a = bucketFor({ ...LIMIT, scope: "login" }, "x", now);
  const b = bucketFor({ ...LIMIT, scope: "generate" }, "x", now);
  assert.notEqual(a.bucket, b.bucket);
});

test("crossing a window boundary starts a new bucket", () => {
  const base = 1_000_000_000_000;
  const start = bucketFor(LIMIT, "u", base).start.getTime();
  const next = bucketFor(LIMIT, "u", start + LIMIT.windowSeconds * 1000).bucket;
  assert.notEqual(bucketFor(LIMIT, "u", base).bucket, next);
});

test("the window start is floored, not the call time", () => {
  const { start } = bucketFor(LIMIT, "u", 1_000_000_037_123);
  assert.equal(start.getTime() % (LIMIT.windowSeconds * 1000), 0);
});

test("the bucket key is a digest, so no email or IP is stored in the clear", () => {
  const { bucket } = bucketFor(LIMITS.loginByEmail, "someone@example.com", Date.now());
  assert.match(bucket, /^[0-9a-f]{64}$/);
  assert.ok(!bucket.includes("example"));
});

test("every configured limit is sane", () => {
  for (const [name, limit] of Object.entries(LIMITS)) {
    assert.ok(limit.max > 0, `${name} max`);
    assert.ok(limit.windowSeconds > 0, `${name} window`);
    assert.ok(limit.scope.length > 0, `${name} scope`);
  }
  // The paid endpoints are the reason this exists; regeneration is the
  // iterative one so it must be the looser of the two.
  assert.ok(LIMITS.regenerate.max > LIMITS.generate.max);
  // Per-IP is looser than per-email: an office behind one NAT address is many
  // legitimate people, but one email address is one account.
  assert.ok(LIMITS.loginByIp.max > LIMITS.loginByEmail.max);
});

test("retry-after is phrased for a person, not a machine", () => {
  assert.equal(describe(1), "1 second");
  assert.equal(describe(45), "45 seconds");
  assert.equal(describe(120), "2 minutes");
  assert.equal(describe(3600), "60 minutes");
});
