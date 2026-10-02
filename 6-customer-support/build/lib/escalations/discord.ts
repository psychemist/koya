import { config } from '../config.ts';
import { callbackLine, type Alert } from './alert.ts';

const DISCORD_LIMIT = 2000;

/**
 * Best effort, one try: the support email is the alert of record, so a
 * Discord outage never holds up or fails an escalation, and is never retried.
 * Mentions are off because the reason quotes the customer, and a customer who
 * types @everyone must not ping the channel.
 */
export async function postToDiscord(a: Alert): Promise<'sent' | 'failed' | 'skipped'> {
  const url = config.escalation.discordWebhookUrl;
  if (!url) return 'skipped';
  const content = [`**Escalation ${a.ref}** (${a.category})`, a.reason, callbackLine(a), a.consoleUrl].join('\n');
  const clipped = content.length <= DISCORD_LIMIT ? content
    : `${content.slice(0, DISCORD_LIMIT - a.consoleUrl.length - 2)}…\n${a.consoleUrl}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: clipped, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(config.escalation.stepTimeoutMs) });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
