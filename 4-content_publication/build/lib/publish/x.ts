import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config';
import type { Connector, PublishResult } from './types';

/**
 * X — pay-per-use, and the cost is the design constraint.
 *
 * Since 6 February 2026 there is no free tier and no new Basic or Pro.
 * Pay-per-use is $0.015 per post — $0.20 if the post contains a link.
 * Our posts contain links.
 *
 * $0.20 is roughly 45% of what producing the ENTIRE content pack costs. That
 * is not a rounding error, so X publication is an explicit per-request opt-in
 * (`content_requests.publish_to_x`) gated behind FEATURE_X_PUBLISH, rather
 * than a checkbox that is on by default and quietly spends money.
 *
 * With the feature off or credentials absent, the queue row records
 * `queued_manual` with copy-ready text. Still a complete deliverable — the
 * post was researched, drafted, evaluated and approved — just posted by hand.
 */
export class XConnector implements Connector {
  readonly channel = 'x' as const;

  available(): boolean {
    return Boolean(
      config.featureXPublish &&
      config.x.apiKey && config.x.apiSecret &&
      config.x.accessToken && config.x.accessSecret,
    );
  }

  async publish(payload: Record<string, unknown>, _idempotencyKey: string): Promise<PublishResult> {
    if (!this.available()) {
      return {
        ok: false,
        code: config.featureXPublish ? 'x_not_configured' : 'x_publishing_disabled',
        retryable: false,
        blocked: true,
      };
    }
    const text = String(payload.body ?? '');
    if (!text.trim()) return { ok: false, code: 'x_empty_body', retryable: false };
    // Belt and braces: Tier 0 already blocks this, but a connector that posts
    // an over-length body would fail at the provider and burn the charge.
    if ([...text].length > 280) return { ok: false, code: 'x_body_too_long', retryable: false };

    const url = 'https://api.twitter.com/2/tweets';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: this.oauth1Header('POST', url),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.ok) {
        const json = await res.json() as any;
        return { ok: true, providerId: json?.data?.id ?? 'unknown' };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: `x_auth_${res.status}`, retryable: false, blocked: true };
      }
      // 402 means the account is out of credit. Retrying that is a loop.
      if (res.status === 402) {
        return { ok: false, code: 'x_payment_required', retryable: false, blocked: true };
      }
      return {
        ok: false,
        code: `x_http_${res.status}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return { ok: false, code: timedOut ? 'x_timeout' : 'x_unreachable', retryable: true };
    }
  }

  /** OAuth 1.0a. X still requires it for user-context posting. */
  private oauth1Header(method: string, url: string): string {
    const params: Record<string, string> = {
      oauth_consumer_key: config.x.apiKey!,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: config.x.accessToken!,
      oauth_version: '1.0',
    };
    const enc = (s: string) =>
      encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    const paramString = Object.keys(params).sort()
      .map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
    const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
    const signingKey = `${enc(config.x.apiSecret!)}&${enc(config.x.accessSecret!)}`;
    const signature = createHmac('sha1', signingKey).update(base).digest('base64');

    const all = { ...params, oauth_signature: signature };
    return 'OAuth ' + Object.keys(all).sort()
      .map((k) => `${enc(k)}="${enc((all as any)[k])}"`).join(', ');
  }
}
