import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { postToDiscord, postEmailGaveUp } from '../../lib/escalations/discord.ts';
import { sendSupportEmail } from '../../lib/escalations/support-email.ts';
import type { Alert, BookingOutcome } from '../../lib/escalations/alert.ts';
import { startStub, type Stub } from '../fakes/http-stub.ts';

// Two Discord channels: escalations that went through, and ones the team must act on by hand.
let discord: Stub, discordErrors: Stub, resend: Stub, discordStatus = 204, resendStatus = 200;
before(async () => {
  discord = await startStub(async () => ({ status: discordStatus, json: {} }));
  discordErrors = await startStub(async () => ({ status: discordStatus, json: {} }));
  resend = await startStub(async () => ({ status: resendStatus, json: { id: 'em_1' } }));
  Object.assign(process.env, { DISCORD_SUCCESS_WEBHOOK_URL: discord.url, DISCORD_ERROR_WEBHOOK_URL: discordErrors.url,
    RESEND_API_URL: resend.url, RESEND_API_KEY: 're_test', SUPPORT_INBOX: 'support@example.com', ESCALATION_STEP_TIMEOUT_MS: '2000' });
});
after(async () => { await discord.close(); await discordErrors.close(); await resend.close(); });

const alert = (outcome: BookingOutcome, patch: Partial<Alert> = {}): Alert => ({ ref: 'RP-E-000004', category: 'account',
  reason: 'Account restricted.', userName: 'Efua Mensah', userEmail: 'efua@accrastack.example',
  requestedSlot: outcome === 'no_slot' ? null : '2026-10-06T14:00:00.000Z', consoleUrl: 'http://localhost:3000/console/escalations/x',
  outcome, ...patch });
const OUTCOMES: BookingOutcome[] = ['booked', 'slot_taken', 'no_slot', 'booking_failed'];
const posts = () => [discord.calls.length, discordErrors.calls.length];
const withoutEnv = async (k: string, fn: () => Promise<void>) => {
  const saved = process.env[k]; delete process.env[k];
  try { await fn(); } finally { process.env[k] = saved; }
};

test('Discord gets the reference, the booking and the console link, with mentions switched off', async () => {
  assert.equal(await postToDiscord(alert('booked')), 'sent');
  const { body } = discord.calls.at(-1)!;
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /^\*\*Escalation RP-E-000004\*\* \(account\)\nAccount restricted\.\nCallback booked for 2026-10-06 14:00 UTC\.\nhttp:\/\/localhost:3000\/console\/escalations\/x$/);
});

test('booked, taken and no-time escalations go to the success channel only', async () => {
  for (const o of ['booked', 'slot_taken', 'no_slot'] as const) {
    const [ok, err] = posts();
    assert.equal(await postToDiscord(alert(o)), 'sent');
    assert.deepEqual(posts(), [ok + 1, err], o);
  }
});

test('a failed booking goes to the error channel only', async () => {
  const [ok, err] = posts();
  assert.equal(await postToDiscord(alert('booking_failed')), 'sent');
  assert.deepEqual(posts(), [ok, err + 1]);
  assert.match(discordErrors.calls.at(-1)!.body.content, /The calendar booking failed/);
  assert.deepEqual(discordErrors.calls.at(-1)!.body.allowed_mentions, { parse: [] });
});

test('an email that gave up is posted to the error channel, with the reason and the console link', async () => {
  const [ok, err] = posts();
  assert.equal(await postEmailGaveUp(alert('booked'), 'resend returned 500', 3), 'sent');
  assert.deepEqual(posts(), [ok, err + 1]);
  const { body } = discordErrors.calls.at(-1)!;
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /^\*\*Escalation RP-E-000004\*\* \(account\): the support email was not delivered after 3 attempts \(resend returned 500\)\./);
  assert.match(body.content, /http:\/\/localhost:3000\/console\/escalations\/x$/);
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
  assert.equal(await postEmailGaveUp(alert('booked'), 'x', 3), 'failed');
  discordStatus = 204;
});

test('an unset channel is skipped, and its messages never fall back to the other channel', async () => {
  await withoutEnv('DISCORD_SUCCESS_WEBHOOK_URL', async () => {
    const before = posts();
    assert.equal(await postToDiscord(alert('booked')), 'skipped');
    assert.deepEqual(posts(), before);
  });
  await withoutEnv('DISCORD_ERROR_WEBHOOK_URL', async () => {
    const before = posts();
    assert.equal(await postToDiscord(alert('booking_failed')), 'skipped');
    assert.equal(await postEmailGaveUp(alert('booked'), 'x', 3), 'skipped');
    assert.deepEqual(posts(), before);
  });
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
    await postToDiscord(alert(o)); await sendSupportEmail(alert(o)); await postEmailGaveUp(alert(o), 'resend returned 500', 3);
    const channel = o === 'booking_failed' ? discordErrors.calls.at(-2)! : discord.calls.at(-1)!;
    const text = [channel.body.content, discordErrors.calls.at(-1)!.body.content, resend.calls.at(-1)!.body.subject,
      resend.calls.at(-1)!.body.text].join('\n');
    assert.doesNotMatch(text, /—/, o);
  }
});
