import React from 'react';
import Link from 'next/link';
import { requireUserPage } from '@/lib/auth';
import { query } from '@/lib/db';
import { connectorAvailability } from '@/lib/publish';
import { QueueState } from '@/app/ui/status';
import PostManually from '@/app/ui/post-manually';

export const dynamic = 'force-dynamic';

type Row = {
  id: string; channel: string; state: string; error_code: string | null;
  attempts: number; due_at: string; idea: string; provider_message_id: string | null;
  request_id: string; payload: any;
};

const CHANNEL_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn', x: 'X', newsletter: 'Newsletter',
};

/**
 * What "off" actually means, per channel, including whether turning it on
 * costs anything. Two of the three are free and were reading as though they
 * were not.
 */
const OFF_REASON: Record<string, string> = {
  linkedin: 'No access token. Posting to a member profile is free through the self-serve product, so this needs a token rather than a budget.',
  x: 'Off by default. No free API tier since February 2026: $0.015 a post, $0.20 with a link. Opted into per request.',
  newsletter: 'Neither the n8n lane nor Resend is configured, so rows record blocked.',
};

const ON_NOTE: Record<string, string> = {
  linkedin: 'Posting as the named member, free',
  x: 'Pay per post, opted into per request',
  newsletter: 'Sending through n8n, Gmail first',
};

export default async function QueuePage() {
  await requireUserPage('/queue');

  // Same rule as the request list: an unreachable database is not an empty
  // queue, and "nothing is waiting to go out" is the single most dangerous
  // thing this page could say when it does not know.
  let rows: Row[] | null = null;
  let loadError: string | null = null;
  try {
    rows = await query<Row>(
      `select q.id, q.channel, q.state, q.error_code, q.attempts, q.due_at,
              q.provider_message_id, q.request_id, q.payload, r.idea
         from public.publish_queue q
         join public.content_requests r on r.id = q.request_id
        order by q.due_at desc limit 100`);
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'The database did not respond.';
  }

  const availability = connectorAvailability();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Publishing queue</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          A channel with no credentials records blocked, never a false sent. Sent is written
          only once the provider confirms it, and the approval is checked again immediately
          before anything goes out.
        </p>
      </header>

      <section className="sheet p-4">
        <h2 className="text-sm font-semibold">Channels</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {Object.entries(availability).map(([channel, live]) => (
            <li key={channel} className="flex items-start gap-2.5">
              <span className={`mt-1 size-2 shrink-0 rounded-full ${live ? 'bg-ok' : 'bg-rule-strong'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {CHANNEL_LABEL[channel] ?? channel}
                  <span className={`ml-1.5 font-normal ${live ? 'text-ok' : 'text-muted'}`}>
                    {live ? 'live' : 'off'}
                  </span>
                </p>
                <p className="text-xs text-muted">
                  {live ? ON_NOTE[channel] : OFF_REASON[channel]}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {loadError && (
        <div className="sheet border-blocking/30 bg-blocking-bg p-4">
          <h2 className="text-sm font-semibold text-blocking">The queue could not be read</h2>
          <p className="mt-1 text-sm text-ink-70">
            This does not mean nothing is waiting to go out. It means the database did not
            answer and the queue is unknown.
          </p>
          <p className="ident mt-2">{loadError}</p>
        </div>
      )}

      {rows && rows.length === 0 && (
        <p className="sheet p-10 text-center text-sm text-muted">
          Nothing is queued. Rows arrive here when an editor approves a channel asset.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="sheet overflow-hidden">
          <table className="w-full text-sm">
            <caption className="sr-only">Publishing queue, most recently due first</caption>
            <thead>
              <tr className="border-b border-rule bg-sunk/50 text-left text-xs text-muted">
                <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Channel</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Request</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                /*
                 * THE ROWS THAT NEED A PERSON GET THE CONTROL TO BE THAT PERSON.
                 *
                 * `queued_manual` is not a failure: the post was researched,
                 * written, checked and approved, and nobody opted into paying
                 * X for the API. But the screen said "Post by hand" and offered
                 * no way to do it, so the text lived somewhere else entirely
                 * and an honest design read as an unfinished one. `blocked` is
                 * the same shape: a missing credential, not a bad post.
                 */
                const needsAPerson = q.state === 'queued_manual' || q.state === 'blocked';
                const body = typeof q.payload?.body === 'string' ? q.payload.body : '';
                const showManual = needsAPerson && Boolean(body);
                return (
                  <React.Fragment key={q.id}>
                    <tr className={showManual ? 'align-top' : 'border-b border-rule align-top last:border-0'}>
                      <td className="px-4 py-3">
                        <QueueState state={q.state} />
                        {q.error_code && (
                          <p className="ident mt-1">{q.error_code.replace(/_/g, ' ')}</p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink-70">
                        {CHANNEL_LABEL[q.channel] ?? q.channel}
                        {q.channel === 'x' && q.payload?.estimatedCostUsd != null && (
                          <span className="block text-xs tabular-nums text-muted">
                            ${Number(q.payload.estimatedCostUsd).toFixed(3)}
                            {Number(q.payload.estimatedCostUsd) < 0.1 ? ', no link' : ', with a link'}
                          </span>
                        )}
                      </td>
                      <td className="max-w-0 px-4 py-3">
                        <Link
                          href={`/requests/${q.request_id}`}
                          className="block truncate hover:underline"
                        >
                          {q.idea}
                        </Link>
                        {q.provider_message_id && (
                          <span className="ident">confirmed as {q.provider_message_id}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">
                        {new Date(q.due_at).toLocaleString()}
                        {q.attempts > 1 && (
                          <span className="block text-xs">{q.attempts} attempts</span>
                        )}
                      </td>
                    </tr>
                    {/* Its own full-width row rather than squeezed into the
                        Request cell — a wrapped button row there stretched
                        that one cell tall while Due sat emptily beside it. */}
                    {showManual && (
                      <tr className="border-b border-rule last:border-0">
                        <td colSpan={4} className="px-4 pb-3 pt-0">
                          <div className="max-w-md">
                            <PostManually
                              channel={q.channel}
                              body={body}
                              queueRowId={q.id}
                              reason={
                                q.state === 'queued_manual'
                                  ? 'Approved and ready. Nothing is charged, and nothing posts on its own.'
                                  : 'This channel has no credentials configured, so the row records blocked rather than a false sent.'
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
