import { config } from '../config.ts';
import { redactString } from '../sanitise.ts';

/**
 * The degraded lane, in code so it cannot share n8n's failure.
 *
 * Deliberately plain: plain text, no templating, no retry of its own (the
 * outbox sweeper retries). A fallback with its own failure modes is not a
 * fallback. It only ever goes to the support inbox, never to a customer.
 */
export async function sendEscalationFallback(e: { ref: string; category: string; reason: string; userName: string; userEmail: string;
  requestedSlot: string | null; consoleUrl: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const subject = `[RelayPay escalation] ${e.ref} ${e.category}: callback not booked`;
  const text = [
    `Escalation ${e.ref} needs a specialist. The booking workflow was unreachable, so no calendar event was`,
    'created and the Discord channel was not posted to. Please contact the customer to arrange a time.',
    '',
    `Reference: ${e.ref}`,
    `Category: ${e.category}`,
    `Reason: ${e.reason}`,
    `Name: ${e.userName}`,
    `Email: ${e.userEmail}`,
    `Requested time: ${e.requestedSlot ?? 'none given'}`,
    `Console: ${e.consoleUrl}`,
  ].join('\n');
  try {
    const res = await fetch(config.escalation.resendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.escalation.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.escalation.fromEmail, to: [config.escalation.supportInbox], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `resend returned ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: redactString(`resend unreachable: ${(err as Error).message}`) };
  }
}
