import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { postToDiscord } from '../../lib/escalations/discord.ts';
import { sendSupportEmail } from '../../lib/escalations/support-email.ts';
import type { Alert, BookingOutcome } from '../../lib/escalations/alert.ts';
import { startStub, type Stub } from '../fakes/http-stub.ts';

let discord: Stub, resend: Stub, discordStatus = 204, resendStatus = 200;
before(async () => {
  discord = await startStub(async () => ({ status: discordStatus, json: {} }));
  resend = await startStub(async () => ({ status: resendStatus, json: { id: 'em_1' } }));
  Object.assign(process.env, { DISCORD_WEBHOOK_URL: discord.url, RESEND_API_URL: resend.url, RESEND_API_KEY: 're_test',
    SUPPORT_INBOX: 'support@example.com', ESCALATION_STEP_TIMEOUT_MS: '2000' });
});
after(async () => { await discord.close(); await resend.close(); });

const alert = (outcome: BookingOutcome, patch: Partial<Alert> = {}): Alert => ({ ref: 'RP-E-000004', category: 'account',
  reason: 'Account restricted.', userName: 'Efua Mensah', userEmail: 'efua@accrastack.example',
  requestedSlot: outcome === 'no_slot' ? null : '2026-10-06T14:00:00.000Z', consoleUrl: 'http://localhost:3000/console/escalations/x',
  outcome, ...patch });
const OUTCOMES: BookingOutcome[] = ['booked', 'slot_taken', 'no_slot', 'booking_failed'];

test('Discord gets the reference, the booking and the console link, with mentions switched off', async () => {
  assert.equal(await postToDiscord(alert('booked')), 'sent');
  const { body } = discord.calls.at(-1)!;
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /^\*\*Escalation RP-E-000004\*\* \(account\)\nAccount restricted\.\nCallback booked for 2026-10-06 14:00 UTC\.\nhttp:\/\/localhost:3000\/console\/escalations\/x$/);
});

test('a customer who types @everyone cannot ping the channel', async () => {
  await postToDiscord(alert('no_slot', { reason: '@everyone help' }));
  assert.deepEqual(discord.calls.at(-1)!.body.allowed_mentions, { parse: [] });
});

test('a Discord message never exceeds the 2000 character limit', async () => {
  await postToDiscord(alert('no_slot', { reason: 'x'.repeat(5000) }));
  assert.ok(discord.calls.at(-1)!.body.content.length <= 2000);
});

test('Discord is best effort: a refusal is reported, never thrown', async () => {
  discordStatus = 500;
  assert.equal(await postToDiscord(alert('booked')), 'failed');
  discordStatus = 204;
});

test('with no Discord webhook configured, Discord is skipped', async () => {
  const saved = process.env.DISCORD_WEBHOOK_URL; delete process.env.DISCORD_WEBHOOK_URL;
  const before = discord.calls.length;
  assert.equal(await postToDiscord(alert('booked')), 'skipped');
  assert.equal(discord.calls.length, before);
  process.env.DISCORD_WEBHOOK_URL = saved;
});

test('the support email goes to the inbox, in plain text, with a subject that says whether a callback is booked', async () => {
  assert.deepEqual(await sendSupportEmail(alert('booked')), { ok: true });
  let mail = resend.calls.at(-1)!;
  assert.deepEqual(mail.body.to, ['support@example.com']);
  assert.equal(mail.headers.authorization, 'Bearer re_test');
  assert.equal(mail.body.subject, '[RelayPay escalation] RP-E-000004 account: callback booked');
  assert.equal(mail.body.html, undefined);
  assert.match(mail.body.text, /Callback booked for 2026-10-06 14:00 UTC\./);
  await sendSupportEmail(alert('booking_failed'));
  mail = resend.calls.at(-1)!;
  assert.equal(mail.body.subject, '[RelayPay escalation] RP-E-000004 account: callback not booked');
  assert.match(mail.body.text, /Please contact the customer to arrange a time\./);
});

test('a refused support email is an error the outbox can retry, never a throw', async () => {
  resendStatus = 500;
  assert.deepEqual(await sendSupportEmail(alert('booked')), { ok: false, error: 'resend returned 500' });
  resendStatus = 200;
});

test('no alert copy contains an em dash', async () => {
  for (const o of OUTCOMES) {
    await postToDiscord(alert(o)); await sendSupportEmail(alert(o));
    const text = [discord.calls.at(-1)!.body.content, resend.calls.at(-1)!.body.subject, resend.calls.at(-1)!.body.text].join('\n');
    assert.doesNotMatch(text, /—/, o);
  }
});
