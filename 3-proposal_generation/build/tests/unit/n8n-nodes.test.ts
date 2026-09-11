import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The n8n Code nodes, run the way n8n runs them.
 *
 * WHY THIS TEST EXISTS. `Build Discord notice` read its payload from
 * `$input`, which is the GMAIL RESPONSE — id, threadId, labelIds — not the
 * verified request. So `item.ref` rendered as `undefined` in the Discord
 * message and `item.recipient.split('@')` threw, and it threw only against a
 * live Gmail credential, after the client email had already gone out. Nothing
 * in this repository ran that code, so nothing could catch it: the bodies are
 * plain JavaScript embedded in a JSON export, invisible to tsc and to every
 * other suite here.
 *
 * The cost of that particular throw is worth stating, because it is what
 * makes this more than a cosmetic bug. The node runs AFTER the send. An
 * exception makes the workflow answer the app with a failure, the app
 * correctly falls over to its Resend lane, and the client receives the
 * proposal twice.
 *
 * HOW. n8n wraps a Code node body in a function, so top-level `return` works
 * and `$input`, `$()`, `$env` and `$vars` are injected. `new Function` does
 * the same thing here. `$env` is a Proxy that THROWS on property access,
 * because that is what n8n Cloud actually does — returning undefined would
 * make the fail-closed path look tested when it is not.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CODE = join(here, "..", "..", "n8n", "code");
const nodeRequire = createRequire(import.meta.url);

type Json = Record<string, unknown>;
type Result = { json: Json }[];

function runNode(
  file: string,
  ctx: {
    input: Json;
    nodes?: Record<string, Json>;
    /** True reproduces n8n Cloud, where touching `$env` throws. */
    envBlocked?: boolean;
    env?: Record<string, string>;
    vars?: Record<string, string>;
  },
): Result {
  const src = readFileSync(join(CODE, file), "utf8");

  const $input = { first: () => ({ json: ctx.input }) };
  const $ = (name: string) => {
    const node = ctx.nodes?.[name];
    if (!node) throw new Error(`No node named '${name}'`);
    return { first: () => ({ json: node }) };
  };
  const $env = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (ctx.envBlocked) throw new Error("access to env vars denied");
        return ctx.env?.[prop];
      },
    },
  );

  const fn = new Function("$input", "$", "$env", "$vars", "require", `"use strict";\n${src}`);
  return fn($input, $, $env, ctx.vars, nodeRequire) as Result;
}

const SECRET = "shared-secret-between-n8n-and-the-app";

/** The payload the app sends, with the fixed key order the signature depends on. */
const BODY = {
  ref: "KOY-2026-0132",
  proposalId: "8f3c1d2e-0000-4000-8000-000000000001",
  recipient: "amara.diallo@meridian-logistics.example",
  subject: "Your proposal from Koya Talent",
  bodyText: "The proposal is at the link below.",
  proposalLink: "https://example.invalid/p/tok",
  idempotencyKey: "idem-1",
  correlationId: "cor-abc123",
};

function signedRequest(secret = SECRET, at = Math.floor(Date.now() / 1000)): Json {
  const ts = String(at);
  const signature = createHmac("sha256", secret)
    .update(`${ts}.${JSON.stringify(BODY)}`, "utf8")
    .digest("hex");
  return { headers: { "x-koya-timestamp": ts, "x-koya-signature": signature }, body: BODY };
}

/** What the Gmail node actually returns. Note what is NOT in it. */
const GMAIL_RESPONSE: Json = { id: "18f9a2b3c4d5", threadId: "18f9a2b3c4d5", labelIds: ["SENT"] };

/* ------------------------------------------------ 01 verify signature ---- */

test("the secret is read from n8n Variables when $env access is blocked", () => {
  const out = runNode("01-verify-signature.js", {
    input: signedRequest(),
    envBlocked: true,
    vars: { IKE_KOYA_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(out[0]!.json.ok, true);
  assert.equal(out[0]!.json.status, 200);
});

test("the secret is read from the process environment when that is available", () => {
  const out = runNode("01-verify-signature.js", {
    input: signedRequest(),
    envBlocked: false,
    env: { IKE_KOYA_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(out[0]!.json.ok, true);
});

test("blocked env with no Variable fails closed rather than throwing", () => {
  // The original defect: a bare `$env.FOO` threw here, so the node died before
  // its own fail-closed branch could run and the app saw a 500 it could not
  // explain instead of a 401 it could.
  const out = runNode("01-verify-signature.js", {
    input: signedRequest(),
    envBlocked: true,
    vars: {},
  });
  assert.equal(out[0]!.json.ok, false);
  assert.equal(out[0]!.json.status, 401);
  assert.match(String(out[0]!.json.reason), /IKE_KOYA_WEBHOOK_SECRET is not readable/);
});

test("an n8n old enough to have no $vars at all still fails closed", () => {
  const out = runNode("01-verify-signature.js", {
    input: signedRequest(),
    envBlocked: true,
    vars: undefined,
  });
  assert.equal(out[0]!.json.ok, false);
  assert.equal(out[0]!.json.status, 401);
});

test("a forged signature is refused", () => {
  const req = signedRequest();
  (req.headers as Json)["x-koya-signature"] = "00".repeat(32);
  const out = runNode("01-verify-signature.js", {
    input: req,
    envBlocked: true,
    vars: { IKE_KOYA_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(out[0]!.json.ok, false);
  assert.equal(out[0]!.json.reason, "signature mismatch");
});

test("a captured request cannot be replayed outside the window", () => {
  const out = runNode("01-verify-signature.js", {
    input: signedRequest(SECRET, Math.floor(Date.now() / 1000) - 9000),
    envBlocked: true,
    vars: { IKE_KOYA_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(out[0]!.json.ok, false);
  assert.match(String(out[0]!.json.reason), /timestamp outside/);
});

test("a verified request with a missing field is a 400, not a crash", () => {
  const partial = { ...BODY } as Partial<typeof BODY>;
  delete partial.recipient;
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SECRET)
    .update(`${ts}.${JSON.stringify(partial)}`, "utf8")
    .digest("hex");
  const out = runNode("01-verify-signature.js", {
    input: { headers: { "x-koya-timestamp": ts, "x-koya-signature": signature }, body: partial },
    envBlocked: true,
    vars: { IKE_KOYA_WEBHOOK_SECRET: SECRET },
  });
  assert.equal(out[0]!.json.status, 400);
  assert.match(String(out[0]!.json.reason), /payload missing: recipient/);
});

/* ------------------------------------------- 02 build discord notice ---- */

test("the notice reads the payload from Verify signature, not from the Gmail response", () => {
  // This is the reported crash, reproduced exactly: $input is Gmail's reply.
  const out = runNode("02-build-discord-notice.js", {
    input: GMAIL_RESPONSE,
    nodes: { "Verify signature": { ...BODY, ok: true }, "Send client email": GMAIL_RESPONSE },
  });
  const content = String(out[0]!.json.content);
  assert.match(content, /KOY-2026-0132/);
  assert.doesNotMatch(content, /undefined/);
  assert.equal(out[0]!.json.ref, "KOY-2026-0132");
  assert.equal(out[0]!.json.proposalId, BODY.proposalId);
  assert.equal(out[0]!.json.messageId, "18f9a2b3c4d5");
});

test("the notice names the recipient's domain and never the address", () => {
  const out = runNode("02-build-discord-notice.js", {
    input: GMAIL_RESPONSE,
    nodes: { "Verify signature": { ...BODY, ok: true }, "Send client email": GMAIL_RESPONSE },
  });
  const content = String(out[0]!.json.content);
  assert.match(content, /meridian-logistics\.example/);
  // The local part is personal data and the channel is wider than the deal team.
  assert.doesNotMatch(content, /amara\.diallo/);
});

test("the notice does not throw on a malformed recipient", () => {
  // It runs after the client already has the email, so a throw here makes the
  // app fail over and send a second copy. It must degrade instead.
  for (const recipient of [undefined, null, "", "no-at-sign", "trailing@"]) {
    const out = runNode("02-build-discord-notice.js", {
      input: GMAIL_RESPONSE,
      nodes: {
        "Verify signature": { ...BODY, recipient } as Json,
        "Send client email": GMAIL_RESPONSE,
      },
    });
    assert.match(String(out[0]!.json.content), /their domain/);
  }
});

/* ------------------------------------------- 03 build failure notice ---- */

test("a refused request reports 401 and names the secret to check", () => {
  const refusal: Json = { ok: false, status: 401, reason: "signature mismatch" };
  const out = runNode("03-build-failure-notice.js", {
    input: refusal,
    nodes: { "Verify signature": refusal },
  });
  assert.equal(out[0]!.json.status, 401);
  assert.match(String(out[0]!.json.content), /REJECTED/);
  assert.match(String(out[0]!.json.content), /IKE_KOYA_WEBHOOK_SECRET/);
});

test("a Gmail failure keeps the reference, which arrives from Verify signature", () => {
  // Gmail's error output carries no ref. An alert saying `unknown` where the
  // reference goes is the one alert somebody actually has to act on.
  const out = runNode("03-build-failure-notice.js", {
    input: { error: { message: "Gmail: quota exceeded" } },
    nodes: { "Verify signature": { ...BODY, ok: true } },
  });
  assert.equal(out[0]!.json.status, 500);
  assert.equal(out[0]!.json.ref, "KOY-2026-0132");
  assert.match(String(out[0]!.json.content), /quota exceeded/);
  assert.match(String(out[0]!.json.content), /cor-abc123/);
});

test("the failure notice does not throw when no node before it produced a payload", () => {
  const out = runNode("03-build-failure-notice.js", {
    input: { error: { message: "something broke" } },
    nodes: {},
  });
  assert.equal(out[0]!.json.ref, "unknown");
  assert.equal(out[0]!.json.status, 500);
});

/* ------------------------------------------------- the build artefact ---- */

test("the exported workflow matches the code files it was generated from", () => {
  // The JSON is a build artefact. A Code node edited in the n8n UI and
  // exported over the top of it would be invisible to every test above.
  const exported = readFileSync(
    join(here, "..", "..", "n8n", "koya-proposal-delivery.json"),
    "utf8",
  );
  const workflow = JSON.parse(exported) as { nodes: { name: string; parameters: Json }[] };
  const pairs: [string, string][] = [
    ["Verify signature", "01-verify-signature.js"],
    ["Build Discord notice", "02-build-discord-notice.js"],
    ["Build failure notice", "03-build-failure-notice.js"],
  ];
  for (const [nodeName, file] of pairs) {
    const node = workflow.nodes.find((n) => n.name === nodeName);
    assert.ok(node, `${nodeName} is missing from the export`);
    assert.equal(
      node.parameters.jsCode,
      readFileSync(join(CODE, file), "utf8"),
      `${nodeName} is stale. Run: npm run build:workflow`,
    );
  }
});
