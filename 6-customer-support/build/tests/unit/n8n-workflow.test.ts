import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const wf = JSON.parse(readFileSync(new URL('../../n8n/relaypay-escalation.json', import.meta.url), 'utf8'));
const raw = JSON.stringify(wf);

test('no Discord webhook URL or credential secret is inlined in the export', () => {
  assert.ok(!/discord(app)?\.com\/api\/webhooks/.test(raw));
  assert.ok(!/"(password|apiKey|accessToken|clientSecret)"\s*:\s*"[^"{]/.test(raw));
});

test('the signature is verified before anything posts, books or emails', () => {
  const names = wf.nodes.map((n: any) => n.name);
  for (const n of ['Webhook', 'Verify signature', 'Check free/busy', 'Create event', 'Post to Discord', 'Email support', 'Respond'])
    assert.ok(names.includes(n), `missing node ${n}`);
  assert.deepEqual(wf.connections['Webhook'].main[0].map((c: any) => c.node), ['Verify signature']);
});

test('the event is looked up by idempotency key before one is created', () => {
  assert.ok(wf.nodes.some((n: any) => n.name === 'Find existing event'));
});

test('the verifier reads the RelayPay secret and headers, not the Week 5 ones', () => {
  const code = wf.nodes.find((n: any) => n.name === 'Verify signature').parameters.jsCode;
  assert.match(code, /RELAYPAY_ESCALATION_SECRET/);
  assert.match(code, /x-relaypay-signature/);
  assert.doesNotMatch(code, /KOYA_LEAD|x-koya/);
});

test('every connection names a node that exists', () => {
  const names = new Set(wf.nodes.map((n: any) => n.name));
  for (const [from, out] of Object.entries<any>(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const branch of out.main) for (const c of branch) assert.ok(names.has(c.node), `${from} -> ${c.node}`);
  }
});
