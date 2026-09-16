import { config } from '../config';
import type { Connector, PublishResult } from './types';

/**
 * LinkedIn — member profile only.
 *
 * Posting to your own profile is self-serve via the `w_member_social` scope
 * and works today. Posting to a COMPANY PAGE, or on behalf of another person,
 * requires partner approval, and SNAP is not accepting new partners: no form,
 * no waitlist, no published timeline.
 *
 * An agency publishing for clients needs precisely the thing that is closed.
 * That is documented as a limitation rather than faked, because the honest
 * version of this constraint is worth more than a demo that pretends.
 */
export class LinkedInConnector implements Connector {
  readonly channel = 'linkedin' as const;

  available(): boolean {
    return Boolean(config.linkedinToken && config.linkedinUrn);
  }

  async publish(payload: Record<string, unknown>, idempotencyKey: string): Promise<PublishResult> {
    if (!this.available()) {
      return { ok: false, code: 'linkedin_not_configured', retryable: false, blocked: true };
    }
    const text = String(payload.body ?? '');
    if (!text.trim()) return { ok: false, code: 'linkedin_empty_body', retryable: false };

    try {
      const res = await fetch('https://api.linkedin.com/rest/posts', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.linkedinToken}`,
          'content-type': 'application/json',
          'LinkedIn-Version': '202601',
          'X-Restli-Protocol-Version': '2.0.0',
          // LinkedIn dedupes on this server-side. Our UNIQUE key covers the
          // race between workers; this covers a retry after a timeout, which
          // is the case where we genuinely do not know whether it landed.
          'X-RestLi-Method': 'create',
          'x-li-idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          author: config.linkedinUrn,
          commentary: text,
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 201 || res.ok) {
        const id = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? 'unknown';
        return { ok: true, providerId: id };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: `linkedin_auth_${res.status}`, retryable: false, blocked: true };
      }
      return {
        ok: false,
        code: `linkedin_http_${res.status}`,
        retryable: res.status === 429 || res.status >= 500,
      };
    } catch (e) {
      // A timeout is NOT a failure to post. It is an unknown, and it is
      // exactly why the idempotency key exists — the retry is safe.
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return { ok: false, code: timedOut ? 'linkedin_timeout' : 'linkedin_unreachable', retryable: true };
    }
  }
}
