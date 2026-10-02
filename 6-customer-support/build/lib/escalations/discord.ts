import { config } from '../config.ts';
import { callbackLine, type Alert } from './alert.ts';

const DISCORD_LIMIT = 2000;
type Posted = 'sent' | 'failed' | 'skipped';

/**
 * Best effort, one try: the support email is the alert of record, so a
 * Discord outage never holds up or fails an escalation, and is never retried.
 * Mentions are off because the reason quotes the customer, and a customer who
 * types @everyone must not ping the channel.
 *
 * Two channels. Success: the escalation went through as asked. Error: the team
 * has to act by hand. An unset channel is skipped; its messages never fall
 * back to the other one, where they would read as the wrong kind of news.
 */
async function post(url: string | null, content: string, consoleUrl: string): Promise<Posted> {
  if (!url) return 'skipped';
  const clipped = content.length <= DISCORD_LIMIT ? content
    : `${content.slice(0, DISCORD_LIMIT - consoleUrl.length - 2)}…\n${consoleUrl}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: clipped, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(config.escalation.stepTimeoutMs) });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** The escalation alert. A failed booking goes to the error channel, everything else to the success channel. */
export function postToDiscord(a: Alert): Promise<Posted> {
  const url = a.outcome === 'booking_failed' ? config.escalation.discordErrorWebhookUrl : config.escalation.discordSuccessWebhookUrl;
  return post(url, [`**Escalation ${a.ref}** (${a.category})`, a.reason, callbackLine(a), a.consoleUrl].join('\n'), a.consoleUrl);
}

/** Sent once, when the support email gives up: without it, nobody would hear about this escalation at all. */
export function postEmailGaveUp(a: Alert, error: string, attempts: number): Promise<Posted> {
  return post(config.escalation.discordErrorWebhookUrl, [
    `**Escalation ${a.ref}** (${a.category}): the support email was not delivered after ${attempts} attempts (${error}).`,
    'The support inbox has not been told about it. Please pick it up from the console.',
    a.consoleUrl,
  ].join('\n'), a.consoleUrl);
}
