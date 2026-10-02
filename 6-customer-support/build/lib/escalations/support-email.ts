import { config } from '../config.ts';
import { redactString } from '../sanitise.ts';
import { callbackLine, type Alert } from './alert.ts';

/**
 * The alert of record: every escalation reaches the support inbox, booked or
 * not. When the booking failed, this email is how the team finds out to
 * arrange a time by hand.
 *
 * Deliberately plain: plain text (the reason quotes the customer, so no
 * markup), no templating, no retry of its own (the outbox sweeper retries).
 * It only ever goes to the support inbox, never to a customer.
 */
export async function sendSupportEmail(a: Alert): Promise<{ ok: true } | { ok: false; error: string }> {
  const subject = `[RelayPay escalation] ${a.ref} ${a.category}: ${a.outcome === 'booked' ? 'callback booked' : 'callback not booked'}`;
  const text = [
    `Escalation ${a.ref} needs a specialist.`,
    callbackLine(a),
    '',
    `Reference: ${a.ref}`,
    `Category: ${a.category}`,
    `Reason: ${a.reason}`,
    `Name: ${a.userName}`,
    `Email: ${a.userEmail}`,
    `Requested time: ${a.requestedSlot ?? 'none given'}`,
    `Console: ${a.consoleUrl}`,
  ].join('\n');
  try {
    const res = await fetch(config.escalation.resendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.escalation.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.escalation.fromEmail, to: [config.escalation.supportInbox], subject, text }),
      signal: AbortSignal.timeout(config.escalation.stepTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `resend returned ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: redactString(`resend unreachable: ${(err as Error).message}`) };
  }
}
