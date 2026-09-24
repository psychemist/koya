import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Node = {
  name: string; type: string; typeVersion: number;
  onError?: string; parameters?: any; credentials?: Record<string, unknown>;
};

const workflow = JSON.parse(readFileSync(
  new URL('../../n8n/koya-lead-notify.json', import.meta.url), 'utf8')) as {
    nodes: Node[]; connections: Record<string, { main: { node: string }[][] }>;
  };

const byName = (name: string) => workflow.nodes.find((n) => n.name === name);

/**
 * The Resend lane lives in the application, not here.
 *
 * A fallback inside the thing that just failed is not a fallback: if n8n is
 * unreachable, an n8n node cannot rescue the message. The application holds
 * the Resend key and sends directly when this workflow does not answer.
 */
test('nothing in the workflow sends through Resend', () => {
  // Checks what a node would actually DO, not what its comments mention: the
  // failure branch explains in prose why Resend lives in the application, and
  // that explanation is the point rather than a violation.
  const senders = workflow.nodes.filter((n) => {
    const url = String(n.parameters?.url ?? '');
    const body = String(n.parameters?.jsonBody ?? '');
    return /resend/i.test(n.name) || /api\.resend\.com/.test(url + body);
  });
  assert.deepEqual(senders.map((n) => n.name), [],
    'Resend belongs in the application, where it can cover n8n being down');
});

test('the workflow holds no raw credential, only credential references', () => {
  const raw = JSON.stringify(workflow);
  assert.ok(!/discord(app)?\.com\/api\/webhooks\//.test(raw),
    'a Discord webhook URL is in a node parameter');
  assert.ok(!/re_[A-Za-z0-9_-]{8,}|sk-ant-|apify_api_/.test(raw), 'a credential is in the export');
  for (const node of workflow.nodes.filter((n) => n.type.endsWith('.discord'))) {
    assert.ok(node.credentials?.discordWebhookApi,
      `${node.name} must use a credential rather than a URL parameter`);
  }
});

/**
 * A throw in the verify node kills the workflow before the respond node runs,
 * so the application sees a generic 500 and cannot tell a rejected signature
 * from n8n being broken.
 */
test('the verify node continues on error and returns a verdict', () => {
  const verify = byName('Verify signature');
  assert.ok(verify, 'no Verify signature node');
  assert.equal(verify!.onError, 'continueRegularOutput');

  const code = verify!.parameters.jsCode as string;
  assert.ok(!/\bthrow new Error\b/.test(code),
    'the verify node throws, which bypasses the respond node');
  assert.match(code, /ok:\s*false/, 'the verify node must return a verdict');
  assert.match(code, /timingSafeEqual/, 'signature comparison must be constant time');
  assert.match(code, /KOYA_LEAD_NOTIFY_SECRET/,
    'the verify node must read the shared secret by name');
});

/**
 * A signature over the body alone never expires, so a captured request can be
 * replayed into the team's Discord indefinitely.
 */
test('the verify node binds the signature to a timestamp and enforces a window', () => {
  const code = byName('Verify signature')!.parameters.jsCode as string;
  assert.match(code, /x-koya-timestamp/, 'the timestamp header is not read');
  assert.match(code, /TOLERANCE_SECONDS\s*=\s*300/, 'no replay window is enforced');
  assert.match(code, /timestamp \+ '\.' \+ raw/,
    'the signature must cover the timestamp as well as the body');
  assert.match(code, /outside the/, 'an out-of-window request must say why it was refused');
});

test('a missing secret fails closed rather than skipping the check', () => {
  const code = byName('Verify signature')!.parameters.jsCode as string;
  // Both lookups are guarded, because touching $env throws on n8n Cloud.
  assert.match(code, /try\s*\{[\s\S]*\$env/, '$env access must be guarded');
  assert.match(code, /try\s*\{[\s\S]*\$vars/, '$vars access must be guarded');
  assert.match(code, /if \(!secret\)/, 'a missing secret must be handled explicitly');
});

test('an unverified request is answered, not silently dropped', () => {
  const branches = workflow.connections['Verified?'].main;
  assert.equal(branches[0][0].node, 'Route by level', 'the true branch must do the work');
  assert.equal(branches[1][0].node, 'Respond rejected', 'the false branch must answer');
  const rejected = byName('Respond rejected');
  assert.match(String(rejected!.parameters.options.responseCode), /401|\$json\.status/);
});

/**
 * Discord posted but nobody was emailed is not success. The application reads
 * any non-2xx as a failed primary lane and sends through Resend itself,
 * recording `degraded` rather than `sent`.
 */
test('a Gmail failure answers non-2xx so the app falls back rather than believing it sent', () => {
  const gmail = byName('Email via Gmail');
  assert.equal(gmail!.onError, 'continueErrorOutput');

  const [success, failure] = workflow.connections['Email via Gmail'].main;
  assert.equal(success[0].node, 'Acknowledge');
  assert.equal(failure[0].node, 'Build failure notice');

  const respondFailed = byName('Respond failed');
  assert.equal(respondFailed!.parameters.options.responseCode, 502,
    'a failed email lane must not answer 200');
});

test('a feed-only event with no recipients still acknowledges', () => {
  const [hasRecipients, none] = workflow.connections['Anyone to email?'].main;
  assert.equal(hasRecipients[0].node, 'Email via Gmail');
  assert.equal(none[0].node, 'Acknowledge',
    'run_started carries no recipients by design and must not be treated as a failure');
});

test('the webhook keeps the raw body, or the signature checks the wrong bytes', () => {
  const hook = byName('Notify webhook');
  assert.equal(hook!.parameters.options.rawBody, true);
  assert.equal(hook!.parameters.responseMode, 'responseNode');
});
