import { config } from '../lib/config.ts';
import { signPayload } from '../lib/notify/index.ts';

/**
 * Proves the signature check works both ways against the live n8n instance.
 *
 * With --tamper the body is changed after signing, and n8n must reject it
 * before posting anywhere. Both Discord channels staying silent is the pass
 * condition: a channel that can be spoofed is worse than no channel.
 */
const kind = process.argv[2] ?? 'run_complete';
const tamper = process.argv.includes('--tamper');

const url = config.notify.n8nUrl();
const secret = config.notify.n8nSecret();
if (!url || !secret) {
  console.error('N8N_LEAD_NOTIFY_URL and N8N_LEAD_NOTIFY_SECRET must both be set.');
  process.exit(1);
}

const payload = {
  kind,
  level: ['run_partial', 'run_failed', 'run_needs_clarification', 'budget_exhausted_daily']
    .includes(kind) ? 'error' : 'success',
  discordChannel: 'leads-success',
  actionRequired: kind !== 'run_started',
  runId: '00000000-0000-0000-0000-000000000000',
  scope: '',
  title: `Koya Lead Desk smoke test: ${kind}`,
  lines: ['This is a smoke test of the notification lane.', 'No lead data is involved.'],
  recipients: config.notify.recipients(),
  url: `${config.appBaseUrl}/runs/00000000-0000-0000-0000-000000000000`,
  emittedAt: new Date().toISOString(),
};

const signedBody = JSON.stringify(payload);
const timestamp = Math.floor(Date.now() / 1000);
const signature = signPayload(secret, signedBody, timestamp);

// Sign one body, send a different one. This is exactly what an attacker who
// learned the URL but not the secret would produce.
const sentBody = tamper
  ? JSON.stringify({ ...payload, title: 'TAMPERED: this must never reach Discord' })
  : signedBody;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-koya-timestamp': String(timestamp),
    'x-koya-signature': signature,
    'x-koya-idempotency-key': `smoke:${kind}:${Date.now()}`,
  },
  body: sentBody,
  signal: AbortSignal.timeout(15_000),
});

console.log(`mode:     ${tamper ? 'tampered (must be rejected)' : 'correctly signed'}`);
console.log(`status:   ${res.status}`);
console.log(`body:     ${(await res.text()).slice(0, 300)}`);
console.log(tamper
  ? '\nPASS if this was rejected and BOTH Discord channels stayed silent.'
  : '\nPASS if both a Discord message and an email arrived.');
