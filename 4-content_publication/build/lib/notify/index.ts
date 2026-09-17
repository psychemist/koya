import { createHmac } from 'node:crypto';
import { config } from '../config';
import { query, one } from '../db';
import { event } from '../audit';
import { redact, redactString } from '../sanitise';
import { sendFallbackEmail } from './email-fallback';

/**
 * Notifications are EMITTED, not sent.
 *
 * Primary lane: the app POSTs one signed event to an n8n webhook, and n8n
 * fans it out to email and to the two Discord channels. Three reasons:
 *
 *  1. SECRETS MOVE OUT OF THE APP. The Resend key for the main lane and both
 *     Discord webhook URLs live in n8n's credential store. The app cannot
 *     leak a credential it does not hold.
 *  2. ROUTING BECOMES EDITABLE WITHOUT A DEPLOY. Who gets told what is the
 *     thing that changes weekly; that should not require shipping the app.
 *  3. FAN-OUT FAILURE IS ISOLATED. Discord being down is n8n's retry, not a
 *     failed request in the content pipeline.
 *
 * Fallback lane: if n8n is unreachable or unconfigured, the app emails the
 * recipients directly through Resend. Discord is lost in that case. That is
 * the right trade — a missing feed entry is an inconvenience, while "the
 * editor was never told this is waiting on them" stops the work.
 *
 * What the app KEEPS either way, because n8n cannot do it reliably:
 *  - idempotency, via UNIQUE (request_id, kind);
 *  - redaction, before anything leaves the process;
 *  - "silence is not success" — the lane and outcome are recorded and shown
 *    on the request, so the UI never implies someone was told when they weren't.
 *
 * AND THE RULE ABOVE ALL OTHERS: a notification failure must never fail the
 * work it is reporting on. Nothing in this module throws.
 */
export type NotifyKind =
  | 'request_created' | 'research_complete' | 'research_failed'
  | 'angles_ready' | 'draft_ready' | 'needs_review' | 'needs_human'
  | 'approved' | 'changes_requested' | 'rejected'
  | 'published' | 'publish_failed';

/** Failures route to #content-errors. Nothing else does. */
const IS_FAILURE = new Set<NotifyKind>([
  'research_failed', 'needs_human', 'publish_failed', 'rejected',
]);

/** Only the points where the pipeline actually stops and waits for a person. */
const ACTION_REQUIRED = new Set<NotifyKind>(['angles_ready', 'needs_review', 'needs_human']);

export type NotifyInput = {
  kind: NotifyKind;
  requestId: string;
  correlationId: string;
  title: string;
  lines: string[];
  to?: { email: string; name?: string; role: string }[];
  path?: string;
};

export async function notify(input: NotifyInput): Promise<void> {
  const recipients = input.to ?? [];

  // Claim FIRST, then emit. A concurrent retry loses the insert and returns
  // without emitting, rather than both racing n8n. Same discipline as publishing.
  //
  // The claim is written as `pending`, NOT as `sent`. Writing `sent` before
  // anything had been sent meant a crash between the claim and the emit left
  // a row asserting the editor had been told, on the one screen built to make
  // "nobody was told" visible. `pending` that never advances is a visible
  // loose end; `sent` that never happened is a lie with a timestamp on it.
  const claimed = await one<{ id: string }>(
    `insert into public.notifications (request_id, kind, recipient, lane, state)
     values ($1,$2,$3,'n8n','pending')
     on conflict (request_id, kind) do nothing
     returning id`,
    [input.requestId, input.kind, recipients.map((t) => t.email).join(',') || null],
  ).catch(() => null);
  if (!claimed) return;

  const meta = {
    level: IS_FAILURE.has(input.kind) ? ('error' as const) : ('success' as const),
    actionRequired: ACTION_REQUIRED.has(input.kind),
    url: `${config.appBaseUrl}${input.path ?? `/requests/${input.requestId}`}`,
    // Redacted before it leaves the process. Assemble a payload from a request
    // body once, and a credential lives in a Discord channel forever.
    lines: input.lines.map(redactString),
  };

  const primary = await emitToN8n(input, meta, recipients);
  if (primary.ok) {
    await mark(claimed.id, 'n8n', 'sent', null);
    await event({ correlationId: input.correlationId, requestId: input.requestId,
      stage: 'notify.n8n', outcome: 'ok', detail: redact({ kind: input.kind }) });
    return;
  }

  await event({
    correlationId: input.correlationId, requestId: input.requestId,
    stage: 'notify.n8n', outcome: primary.configured ? 'failed' : 'skipped',
    detail: { kind: input.kind, code: primary.code },
  });

  // ---- fallback lane ----
  const fb = await sendFallbackEmail({
    to: recipients.map((r) => r.email),
    subject: input.title,
    lines: meta.lines,
    url: meta.url,
    actionRequired: meta.actionRequired,
  });

  if (fb.ok) {
    // `degraded`, not `sent`. The email went; Discord did not. The request
    // page renders that difference rather than hiding it.
    await mark(claimed.id, 'resend_fallback', 'degraded', primary.code);
    await event({ correlationId: input.correlationId, requestId: input.requestId,
      stage: 'notify.fallback', outcome: 'ok',
      detail: { kind: input.kind, reason: primary.code, discord: 'not delivered' } });
    return;
  }

  // A FEED-ONLY EVENT WITH NOBODY TO EMAIL IS NOT A FAILED NOTIFICATION.
  //
  // `request_created` deliberately carries no recipients: it posts to the
  // team feed and emails no one, because an email per state change teaches
  // people to ignore the emails. The fallback lane reported `no_recipients`
  // for it, which was then written down as `failed` - so the request page
  // showed a red row for a notification that had worked exactly as designed,
  // next to the rows that record real delivery problems. A gate nobody
  // believes is a gate nobody reads.
  const nobodyToEmail = recipients.length === 0;
  const state = nobodyToEmail
    ? (primary.configured ? 'failed' : 'skipped_not_configured')
    : (fb.configured || primary.configured ? 'failed' : 'skipped_not_configured');

  await mark(claimed.id, 'none', state, `${primary.code}/${fb.code}`);
  await event({
    correlationId: input.correlationId, requestId: input.requestId,
    stage: 'notify.fallback', outcome: 'failed',
    detail: { kind: input.kind, n8n: primary.code, resend: fb.code },
  });
}

async function emitToN8n(
  input: NotifyInput,
  meta: { level: 'success' | 'error'; actionRequired: boolean; url: string; lines: string[] },
  recipients: { email: string; name?: string; role: string }[],
): Promise<{ ok: true } | { ok: false; code: string; configured: boolean }> {
  const secret = config.n8nNotifySecret();
  if (!config.n8nNotifyUrl || !secret) {
    return { ok: false, code: 'n8n_not_configured', configured: false };
  }
  try {
    const body = JSON.stringify({
      kind: input.kind,
      level: meta.level,
      discordChannel: meta.level === 'error' ? 'content-errors' : 'content-success',
      actionRequired: meta.actionRequired,
      requestId: input.requestId,
      correlationId: input.correlationId,
      title: input.title,
      lines: meta.lines,
      recipients,
      url: meta.url,
      emittedAt: new Date().toISOString(),
    });

    const res = await fetch(config.n8nNotifyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The webhook is a public URL. Unsigned, it is an open relay into the
        // team's Discord for anyone who learns it.
        'x-koya-signature': createHmac('sha256', secret).update(body).digest('hex'),
        'x-koya-idempotency-key': `${input.requestId}:${input.kind}`,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? { ok: true } : { ok: false, code: `n8n_http_${res.status}`, configured: true };
  } catch (e) {
    return {
      ok: false,
      code: e instanceof Error && e.name === 'TimeoutError' ? 'n8n_timeout' : 'n8n_unreachable',
      configured: true,
    };
  }
}

async function mark(id: string, lane: string, state: string, code: string | null) {
  await query(`update public.notifications set lane=$2, state=$3, error_code=$4 where id=$1`,
    [id, lane, state, code]).catch(() => {});
}

/** Rendered on the request page, so "nobody was told" is visible, not assumed. */
export async function notificationStatus(requestId: string) {
  return query<{ kind: string; lane: string; state: string; error_code: string | null }>(
    `select kind, lane, state, error_code from public.notifications
      where request_id = $1 order by created_at desc`,
    [requestId],
  );
}
