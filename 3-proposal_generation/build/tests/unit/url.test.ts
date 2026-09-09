import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { resolveOrigin, shareUrl } from "../../lib/url";

/**
 * Host-header handling for the one URL in this system that is emailed to a
 * client. The failure being guarded against is a forged `Host` producing a
 * real proposal token on an attacker's domain, sent by us.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.APP_ALLOWED_HOSTS;
});

test("configuration wins outright, whatever the header says", () => {
  withEnv({ APP_BASE_URL: "https://proposals.koya.example" }, () => {
    const result = resolveOrigin("evil.example");
    assert.equal(result.origin, "https://proposals.koya.example");
    assert.equal(result.source, "config");
  });
});

test("a forged host is refused rather than trusted", () => {
  withEnv({ APP_BASE_URL: undefined, APP_ALLOWED_HOSTS: undefined }, () => {
    const result = resolveOrigin("attacker.example");
    assert.equal(result.source, "fallback");
    assert.ok(!result.origin.includes("attacker.example"));
    // Recorded, so the resulting broken link is diagnosable rather than a mystery.
    assert.equal(result.rejectedHost, "attacker.example");
  });
});

test("an allow-listed host is accepted, over https", () => {
  withEnv({ APP_ALLOWED_HOSTS: "proposals.koya.example, preview.koya.example" }, () => {
    assert.equal(resolveOrigin("preview.koya.example").origin, "https://preview.koya.example");
    assert.equal(resolveOrigin("preview.koya.example").source, "allowlisted_host");
  });
});

test("localhost works with no configuration at all, over http", () => {
  const result = resolveOrigin("localhost:3000");
  assert.equal(result.origin, "http://localhost:3000");
  assert.equal(result.source, "local");
});

test("a host carrying a path, a scheme or CRLF is refused", () => {
  for (const hostile of [
    "good.example/../evil.example",
    "good.example\r\nX-Injected: 1",
    "user:pass@evil.example",
    "evil.example/path",
    "http://evil.example",
  ]) {
    const result = resolveOrigin(hostile);
    assert.equal(result.source, "fallback", hostile);
    assert.ok(!result.origin.includes("evil.example"), hostile);
  }
});

test("a missing or empty host falls back without throwing", () => {
  assert.equal(resolveOrigin(null).source, "fallback");
  assert.equal(resolveOrigin("").source, "fallback");
  assert.equal(resolveOrigin("   ").source, "fallback");
});

test("an absurdly long host is refused", () => {
  const result = resolveOrigin(`${"a".repeat(300)}.example`);
  assert.equal(result.source, "fallback");
});

test("an allow-list entry does not match a lookalike suffix", () => {
  withEnv({ APP_ALLOWED_HOSTS: "koya.example" }, () => {
    // The allow-list is compared whole, so this must not pass.
    assert.equal(resolveOrigin("evil-koya.example").source, "fallback");
    assert.equal(resolveOrigin("koya.example.evil.com").source, "fallback");
  });
});

test("host matching is case-insensitive", () => {
  withEnv({ APP_ALLOWED_HOSTS: "koya.example" }, () => {
    assert.equal(resolveOrigin("KOYA.Example").origin, "https://koya.example");
  });
});

test("shareUrl encodes the token and never doubles the slash", () => {
  assert.equal(shareUrl("https://koya.example", "abc-123_x"), "https://koya.example/p/abc-123_x");
  // base64url tokens contain no characters needing escape, but a malformed one
  // must not be able to escape the path.
  assert.ok(!shareUrl("https://koya.example", "../../admin").includes("/../"));
});
