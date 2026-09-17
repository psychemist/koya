import { Resend } from 'resend';
import { config } from '../config';

/**
 * The degraded lane.
 *
 * n8n is primary: it fans one event out to email and both Discord channels.
 * When n8n is unreachable, Discord is simply lost — but the email is not,
 * because the notification that matters is the one telling a person the
 * pipeline is waiting on them. Losing a feed entry is an inconvenience;
 * losing "the editor needs to approve this" stops the work.
 *
 * Deliberately plain: no templating engine, no retry, no queue. A fallback
 * with its own failure modes is not a fallback.
 */
let client: Resend | null = null;

export async function sendFallbackEmail(m: {
  to: string[];
  subject: string;
  lines: string[];
  url: string;
  actionRequired: boolean;
}): Promise<{ ok: true } | { ok: false; code: string; configured: boolean }> {
  if (!config.resendKey) return { ok: false, code: 'resend_not_configured', configured: false };
  if (!m.to.length) return { ok: false, code: 'no_recipients', configured: true };
  client ??= new Resend(config.resendKey);

  const body = m.lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('');
  const cta = m.actionRequired
    ? `<p style="margin:20px 0"><a href="${m.url}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open the request</a></p>`
    : `<p style="margin:20px 0"><a href="${m.url}">${m.url}</a></p>`;

  try {
    const res = await client.emails.send({
      from: config.notifyFrom,
      to: m.to,
      subject: m.actionRequired ? `Action required: ${m.subject}` : m.subject,
      html:
        `<div style="font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px">` +
        `<h2 style="font-size:17px;margin:0 0 14px">${esc(m.subject)}</h2>${body}${cta}` +
        `<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0">` +
        // Said plainly, because a reader who gets this one and not the Discord
        // message should know why, rather than assume the team saw it too.
        `<p style="color:#666;font-size:12px;margin:0">Sent on the fallback lane, because ` +
        `the notification workflow was unreachable, so the Discord channels were not posted to. ` +
        `Nothing is published until a person approves it.</p></div>`,
    });
    if ((res as any)?.error) {
      return { ok: false, code: String((res as any).error?.name ?? 'resend_error'), configured: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e instanceof Error ? e.name : 'resend_exception', configured: true };
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
