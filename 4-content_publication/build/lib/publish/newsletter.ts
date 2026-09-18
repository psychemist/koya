import { createHmac } from 'node:crypto';
import { Resend } from 'resend';
import { config } from '../config';
import type { Connector, PublishResult } from './types';

/**
 * The newsletter, sent through n8n first and Resend second.
 *
 * WHY THAT ORDER, because it is the opposite of what the vendor list suggests.
 *
 * Resend will not deliver to an arbitrary recipient until you have verified a
 * domain. Its shared `onboarding@resend.dev` sender reaches the account owner
 * and nobody else. The call still succeeds, still returns a message id, and
 * the queue would have written `sent` against a newsletter that landed in no
 * subscriber's inbox. That is a false success with a provider id attached to
 * it, which is worse than a plain failure: the one screen built to show what
 * did and did not go out would have been the thing lying.
 *
 * n8n holds a Gmail credential instead. Gmail sends as a real mailbox, needs
 * no domain, costs nothing, and is capped at a few hundred recipients a day.
 * That cap is the honest limit of this lane and it is stated on the admin
 * page rather than discovered on send day.
 *
 * Resend remains the fallback and becomes the better lane the moment a domain
 * is verified, which is why it is kept rather than deleted.
 *
 * Note this is a DIFFERENT use of both vendors from lib/notify: that lane
 * tells a colleague the pipeline is waiting on them, this one publishes
 * approved content to a list. Same vendors, different job, and they fail
 * independently.
 */
let client: Resend | null = null;

export class NewsletterConnector implements Connector {
  readonly channel = 'newsletter' as const;

  available(): boolean {
    return Boolean(
      (config.n8nPublishUrl && config.n8nPublishSecret()) || config.resendKey,
    );
  }

  async publish(payload: Record<string, unknown>, idempotencyKey: string): Promise<PublishResult> {
    if (!this.available()) {
      return { ok: false, code: 'newsletter_not_configured', retryable: false, blocked: true };
    }
    const subject = String(payload.subjectLine ?? '').trim();
    const body = String(payload.body ?? '');
    const to = ((payload.recipients as string[] | undefined) ?? [])
      .map((e) => String(e).trim())
      .filter((e) => e.includes('@'));

    if (!subject) return { ok: false, code: 'newsletter_no_subject', retryable: false };
    // Blocked rather than failed: nothing about this is going to come right on
    // a retry, and it is fixed on the admin page by adding a subscriber.
    if (!to.length) {
      return { ok: false, code: 'newsletter_no_subscribers', retryable: false, blocked: true };
    }

    const html = markdownToHtml(body);

    const viaN8n = await this.sendViaN8n({ subject, html, to, idempotencyKey,
      requestId: String(payload.requestId ?? '') });
    if (viaN8n.ok) return viaN8n;

    const viaResend = await this.sendViaResend({ subject, html, to, idempotencyKey });
    if (viaResend.ok) return viaResend;

    // Both lanes are named in the code, because "newsletter_unreachable" on
    // its own sends whoever is on call to read two integrations instead of one.
    return {
      ok: false,
      code: `${viaN8n.code}/${viaResend.code}`,
      retryable: viaN8n.retryable || viaResend.retryable,
      blocked: viaN8n.blocked && viaResend.blocked,
    };
  }

  private async sendViaN8n(m: {
    subject: string; html: string; to: string[]; idempotencyKey: string; requestId: string;
  }): Promise<PublishResult> {
    const secret = config.n8nPublishSecret();
    if (!config.n8nPublishUrl || !secret) {
      return { ok: false, code: 'n8n_publish_not_configured', retryable: false, blocked: true };
    }
    try {
      const body = JSON.stringify({
        requestId: m.requestId,
        idempotencyKey: m.idempotencyKey,
        subject: m.subject,
        html: m.html,
        recipients: m.to,
        emittedAt: new Date().toISOString(),
      });
      const res = await fetch(config.n8nPublishUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The webhook is a public URL. Unsigned it is a way for anyone who
          // learns it to send mail from the team's account to any address.
          'x-koya-signature': createHmac('sha256', secret).update(body).digest('hex'),
          'x-koya-idempotency-key': m.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          code: `n8n_publish_http_${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
      }
      const json = await res.json().catch(() => null) as any;
      // A 200 from this workflow is only reachable after Gmail accepted the
      // message. The workflow throws on an empty recipient list rather than
      // returning a cheerful ok, which is what makes that claim worth anything.
      return { ok: true, providerId: String(json?.providerId ?? m.idempotencyKey) };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return {
        ok: false,
        code: timedOut ? 'n8n_publish_timeout' : 'n8n_publish_unreachable',
        retryable: true,
      };
    }
  }

  private async sendViaResend(m: {
    subject: string; html: string; to: string[]; idempotencyKey: string;
  }): Promise<PublishResult> {
    if (!config.resendKey) {
      return { ok: false, code: 'resend_not_configured', retryable: false, blocked: true };
    }
    client ??= new Resend(config.resendKey);
    try {
      const res = await client.emails.send({
        from: config.notifyFrom,
        to: m.to,
        subject: m.subject,
        html: m.html,
        // Resend dedupes on this, so a retry after a timeout does not send twice.
        headers: { 'Idempotency-Key': m.idempotencyKey },
      });
      if ((res as any)?.error) {
        const name = String((res as any).error?.name ?? 'resend_error');
        return { ok: false, code: name, retryable: /rate|timeout|internal/i.test(name) };
      }
      return { ok: true, providerId: (res as any)?.data?.id ?? 'unknown' };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return {
        ok: false,
        code: timedOut ? 'newsletter_timeout' : 'newsletter_unreachable',
        retryable: true,
      };
    }
  }
}

/** Deliberately minimal. A full markdown renderer is a dependency and an attack surface. */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc(md)
    .replace(/^###\s+(.+)$/gm, '<h3 style="font-size:15px;margin:22px 0 8px">$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2 style="font-size:17px;margin:26px 0 10px">$1</h2>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
    .split(/\n{2,}/)
    .map((block) => block.includes('<li>')
      ? `<ul style="margin:0 0 14px;padding-left:20px">${block}</ul>`
      : /^<h[23]/.test(block) ? block : `<p style="margin:0 0 14px">${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font:15px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:620px">${html}</div>`;
}
