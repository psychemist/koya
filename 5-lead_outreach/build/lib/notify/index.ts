import { createHmac } from 'node:crypto';
import { config } from '../config.ts';
import { query, one } from '../db.ts';
import { redactString } from '../sanitise.ts';
import { sendFallbackEmail } from './email-fallback.ts';
import type { RunRow, RunStats } from '../runs.ts';

/**
 * Notifications are EMITTED, not sent. The worker POSTs one signed event to
 * n8n, and n8n fans it out to Gmail and the two Discord channels, so the Gmail
 * credential and both webhook URLs stay in n8n's credential store.
 *
 * Resend stays HERE rather than in n8n, and that is the one deliberate
 * exception. It is the lane that has to work when n8n is unreachable, so
 * hosting it inside n8n would mean the fallback shares a failure mode with the
 * thing it exists to cover. n8n answering any non-2xx, including the 502 it
 * returns when Gmail refuses a message, drops through to this lane.
 *
 * The agent cannot reach this module. There is no notify tool and there will
 * not be one: a page that can make the agent post into the team's Discord is a
 * page that has reached the team.
 *
 * THE RULE ABOVE ALL OTHERS: a notification failure must never fail the run
 * it is reporting on. Nothing in this module throws.
 */
export type NotifyKind =
  | 'run_started' | 'run_needs_clarification' | 'run_complete'
  | 'run_partial' | 'run_failed' | 'budget_exhausted_daily';

const IS_FAILURE = new Set<NotifyKind>(
  ['run_needs_clarification', 'run_partial', 'run_failed', 'budget_exhausted_daily']);

/** Only the points where the system actually stops and waits for a person. */
const ACTION_REQUIRED = new Set<NotifyKind>(
  ['run_needs_clarification', 'run_partial', 'run_complete', 'budget_exhausted_daily']);

export type Recipient = { email: string; name?: string; role: string };

export type NotifyInput = {
  kind: NotifyKind;
  runId: string;
  scope?: string;
  title: string;
  lines: string[];
  to?: Recipient[];
  path?: string;
  /** Test seam: lets a test observe the claim row before anything is emitted. */
  _onBeforeEmit?: () => Promise<void>;
};

const n = (v: string | number) => Number(v ?? 0).toFixed(2);

/**
 * The terminal digest, not a stream.
 *
 * Two of these lines do not exist in a normal run report and are the reason
 * this system needs its own digest: the flagged-page count and the
 * blocked-draft count. They are the two things a reviewer has to act on, and
 * both are invisible unless something says them out loud.
 */
export function buildDigest(run: RunRow, s: RunStats): string[] {
  const lines = [
    `Objective: ${run.objective}`,
    `Qualified ${s.qualified} of ${s.assessed} candidates assessed. ` +
    `${s.needsReview} needs_review, ${s.notQualified} not qualified.`,
  ];
  // Omit a zero rather than print it. "0 pages were flagged" is a line a
  // reader learns to skip, and the two lines below are the only ones in this
  // message that ask somebody to do something.
  if (s.flaggedPages > 0) {
    lines.push(`${s.flaggedPages} page${s.flaggedPages === 1 ? ' was' : 's were'} flagged ` +
               'as carrying text addressed to an automated reader.');
  }
  if (s.blockedDrafts > 0) {
    lines.push(`${s.blockedDrafts} lead${s.blockedDrafts === 1 ? ' has' : 's have'} blocked ` +
               'drafts and need copy written by hand.');
  }
  if (run.shortfall_reason) lines.push(run.shortfall_reason);
  lines.push(`Apify $${n(run.apify_spend_usd)}. Claude $${n(run.claude_cost_usd)} ` +
             `(client-side estimate, not billing data). ${run.agent_turns} turns.`);
  return lines;
}

export async function notify(input: NotifyInput): Promise<void> {
  const recipients = input.to ?? [];

  // Claim FIRST, then emit, so a concurrent retry loses the insert and returns
  // rather than both racing n8n.
  //
  // The claim is written `pending`, NOT `sent`. A worker that dies between the
  // claim and the emit must leave a visible loose end, not a row asserting the
  // operator was told.
  const claimed = await one<{ id: string }>(
    `insert into public.notifications (run_id, kind, scope, recipient, lane, state)
     values ($1,$2,$3,$4,'n8n','pending')
     on conflict (run_id, kind, scope) do nothing
     returning id`,
    [input.runId, input.kind, input.scope ?? '',
     recipients.map((t) => t.email).join(',') || null],
  ).catch(() => null);
  if (!claimed) return;                       // already emitted, or the database is gone

  if (input._onBeforeEmit) await input._onBeforeEmit().catch(() => undefined);

  const meta = {
    level: IS_FAILURE.has(input.kind) ? ('error' as const) : ('success' as const),
    discordChannel: IS_FAILURE.has(input.kind) ? 'leads-errors' : 'leads-success',
    actionRequired: ACTION_REQUIRED.has(input.kind),
    url: `${config.appBaseUrl}${input.path ?? `/runs/${input.runId}`}`,
    // Redacted before it leaves the process. An operator's objective lands in
    // a Discord channel; assemble that payload once without this and a pasted
    // credential lives there forever.
    lines: input.lines.map(redactString),
  };

  const primary = await emitToN8n(input, meta, recipients);
  if (primary.ok) return mark(claimed.id, 'n8n', 'sent', null);

  const fb = await sendFallbackEmail({
    to: recipients.map((r) => r.email),
    subject: input.title,
    lines: meta.lines,
    url: meta.url,
    actionRequired: meta.actionRequired,
  });
  // `degraded`, not `sent`. The email went; Discord did not. The run page
  // renders that difference rather than hiding it.
  if (fb.ok) return mark(claimed.id, 'resend_fallback', 'degraded', primary.code);

  // A FEED-ONLY EVENT WITH NOBODY TO EMAIL IS NOT A FAILED NOTIFICATION.
  //
  // `run_started` deliberately carries no recipients. Week 4 wrote that down
  // as `failed` and put a red row on the UI for something working as designed,
  // and the first version of this module reproduced the bug exactly: with n8n
  // configured but unreachable, `primary.configured` was true and the state
  // landed on `failed` even though nobody was owed a message.
  //
  // `failed` is reserved for "a person who needed telling was not told". When
  // there was nobody to tell, a lost feed post is `degraded`: something did
  // not arrive, but no one is waiting on it.
  const nobodyToEmail = recipients.length === 0;
  if (nobodyToEmail) {
    return mark(claimed.id, 'none',
      primary.configured ? 'degraded' : 'skipped_not_configured', primary.code);
  }
  const state = (fb.configured || primary.configured) ? 'failed' : 'skipped_not_configured';
  return mark(claimed.id, 'none', state, `${primary.code}/${fb.code}`);
}

type EmitMeta = {
  level: 'success' | 'error'; discordChannel: string;
  actionRequired: boolean; url: string; lines: string[];
};

async function emitToN8n(
  input: NotifyInput, meta: EmitMeta, recipients: Recipient[],
): Promise<{ ok: true } | { ok: false; code: string; configured: boolean }> {
  const url = config.notify.n8nUrl();
  const secret = config.notify.n8nSecret();
  if (!url || !secret) return { ok: false, code: 'n8n_not_configured', configured: false };

  try {
    const body = JSON.stringify({
      kind: input.kind,
      level: meta.level,
      discordChannel: meta.discordChannel,
      actionRequired: meta.actionRequired,
      runId: input.runId,
      scope: input.scope ?? '',
      title: input.title,
      lines: meta.lines,
      recipients,
      url: meta.url,
      emittedAt: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The webhook is a public URL. Unsigned it is an open relay into the
        // team's Discord for anyone who learns it, and a channel that can be
        // spoofed is worse than no channel because people trust what it says.
        'x-koya-timestamp': String(timestamp),
        'x-koya-signature': signPayload(secret, body, timestamp),
        'x-koya-idempotency-key': `${input.runId}:${input.kind}:${input.scope ?? ''}`,
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
  await query('update public.notifications set lane=$2, state=$3, error_code=$4 where id=$1',
    [id, lane, state, code]).catch(() => undefined);
}

export type NotificationRow = {
  kind: string; lane: string; state: string; error_code: string | null; scope: string;
};

/** Rendered on the run page, so "nobody was told" is visible, not assumed. */
export async function notificationStatus(runId: string): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `select kind, lane, state, error_code, scope from public.notifications
      where run_id = $1 order by created_at desc`,
    [runId],
  );
}

export const operatorRecipients = (): Recipient[] => config.notify.recipients();

/** How far out of date a request may be and still be acted on. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The signed material is `${timestamp}.${rawBody}`, not the body alone.
 *
 * A signature over the body by itself is valid for ever, so anyone who
 * captures one request can replay it whenever they like and the team's Discord
 * will repeat whatever it said. Putting the timestamp inside the signed
 * material means the clock cannot be moved without invalidating the signature,
 * and n8n rejects anything outside the window even when the signature checks
 * out.
 */
export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
}
