/**
 * Verify the request actually came from the Proposal Studio.
 *
 * The webhook URL is not a secret — it sits in an environment variable, in a
 * deploy log, and in this workflow's own definition. So the URL alone must not
 * be enough to make this workflow email a client. Every request carries:
 *
 *   x-koya-timestamp   unix seconds
 *   x-koya-signature   HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex
 *
 * The timestamp is inside the signed material, which is what stops a captured
 * request being replayed for ever. Anything outside the window is rejected
 * even if the signature is valid.
 *
 * Comparison is constant-time. A byte-by-byte early exit leaks how much of a
 * forged signature was correct, which is enough to recover one.
 */
const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;

const SECRET_NAME = 'IKE_KOYA_WEBHOOK_SECRET';

/**
 * Where the shared secret comes from, and why this is not a one-liner.
 *
 * `$env` is not available on every n8n instance. n8n Cloud has no process
 * environment a workflow can reach, and self-hosted instances ship with
 * `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` by default. On both, TOUCHING `$env`
 * THROWS rather than returning undefined — which is what the "access to env
 * vars denied" error is. A bare `$env.FOO` therefore does not degrade to a
 * missing secret; it kills the node before the fail-closed branch below can
 * run, and the app sees a 500 instead of a 401 it can explain.
 *
 * So both lookups are attempted and both are guarded:
 *
 *   $env   self-hosted, with N8N_BLOCK_ENV_ACCESS_IN_NODE=false
 *   $vars  n8n Cloud and self-hosted alike — Settings → Variables
 *
 * Order matters only for instances that somehow have both, and process
 * environment wins there because it is the one a deploy pipeline sets.
 */
function readSecret(name) {
  try {
    if (typeof $env !== 'undefined' && $env && $env[name]) return String($env[name]);
  } catch (err) {
    // Env access is blocked on this instance. Not fatal — try Variables.
  }
  try {
    if (typeof $vars !== 'undefined' && $vars && $vars[name]) return String($vars[name]);
  } catch (err) {
    // Neither source is readable. Handled by the fail-closed branch below.
  }
  return null;
}

const secret = readSecret(SECRET_NAME);
if (!secret) {
  // Failing closed. A missing secret must never mean "skip the check".
  return [{
    json: {
      ok: false,
      status: 401,
      reason:
        `${SECRET_NAME} is not readable on this n8n instance. Set it as a ` +
        'Variable (Settings \u2192 Variables), or as an environment variable with ' +
        'N8N_BLOCK_ENV_ACCESS_IN_NODE=false. Its value must match ' +
        'N8N_WEBHOOK_SECRET in the application.',
    },
  }];
}

const item = $input.first();
const headers = item.json.headers || {};
const body = item.json.body || {};

const timestamp = headers['x-koya-timestamp'];
const signature = headers['x-koya-signature'];

if (!timestamp || !signature) {
  return [{ json: { ok: false, status: 401, reason: 'missing signature headers' } }];
}

const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
  return [{ json: { ok: false, status: 401, reason: `timestamp outside the ${TOLERANCE_SECONDS}s window (age ${age}s)` } }];
}

/**
 * The signature was computed over the exact bytes the app sent. n8n has
 * already parsed the body, so it is re-serialised here — which is safe only
 * because the app builds the payload with JSON.stringify over a plain object
 * with a fixed key order. If either side ever reorders those keys, every
 * request starts failing verification, loudly, rather than silently accepting
 * unverified input.
 */
const raw = JSON.stringify(body);
const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');

const a = Buffer.from(String(signature), 'utf8');
const b = Buffer.from(expected, 'utf8');
const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

if (!valid) {
  return [{ json: { ok: false, status: 401, reason: 'signature mismatch' } }];
}

// Payload shape check. A verified request with a missing field is a bug in the
// caller, and reporting it as 400 rather than crashing the workflow is what
// makes it debuggable from the app's own delivery record.
const required = ['ref', 'proposalId', 'recipient', 'subject', 'bodyText', 'proposalLink', 'idempotencyKey'];
const missing = required.filter((key) => !body[key]);
if (missing.length > 0) {
  return [{ json: { ok: false, status: 400, reason: `payload missing: ${missing.join(', ')}` } }];
}

return [{
  json: {
    ok: true,
    status: 200,
    ref: body.ref,
    proposalId: body.proposalId,
    recipient: body.recipient,
    // Copied on the client email, normally the approver who signed it off.
    // Defaulted rather than required: an older caller that does not send it
    // must not be rejected, and an empty list is a valid answer.
    cc: Array.isArray(body.cc) ? body.cc : [],
    subject: body.subject,
    bodyText: body.bodyText,
    proposalLink: body.proposalLink,
    idempotencyKey: body.idempotencyKey,
    correlationId: body.correlationId || null,
    verifiedAt: new Date().toISOString(),
  },
}];
