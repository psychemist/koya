'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Confirm, { type ConfirmSpec } from './confirm';

/**
 * Publishing a post without paying an API, which for X is the only way left.
 *
 * WHERE THE MONEY ACTUALLY IS, as of this build:
 *
 *   LinkedIn  FREE for what this app does. The self-serve "Share on LinkedIn"
 *             product grants `w_member_social` with no review, and that posts
 *             to the authenticated member's own feed. The partner queue people
 *             get stuck in is for COMPANY PAGES and posting on behalf of other
 *             people, neither of which is needed here. The connector is built
 *             and works; it needs a token, not a budget.
 *
 *   X         NOT free, and there is no version of this that is. The free tier
 *             ended on 6 February 2026 and pay-per-use replaced it: $0.015 a
 *             post, $0.20 if the post contains a link. Ours contain links, so
 *             roughly 45% of what the whole content pack costs to produce goes
 *             on posting it once.
 *
 * So the free X route is not an API at all. A web intent opens X's own compose
 * box, already filled in, in the browser session the person is already signed
 * into. They press Post. It costs nothing, it needs no key, no app review and
 * no OAuth, and the post is genuinely theirs rather than an app's.
 *
 * What it cannot do is happen unattended, which is the honest trade and is
 * said here rather than discovered. That is also exactly why the queue records
 * `queued_manual` instead of `sent`: nothing claims this went out until a
 * person says it did.
 *
 * The same intent exists for LinkedIn, and it is offered too, because it is
 * the answer for anyone who has not set a token up yet.
 *
 * A THIRD CONTROL, "I posted this", closes the loop the other two leave open.
 * Copying the text and opening the composer both end at the provider's own
 * site; nothing here learns whether the person actually pressed Post. Without
 * a way back, a row that had genuinely been posted looked identical, forever,
 * to one nobody had touched, and there was no way to tell "still needs doing"
 * from "already done" a week later.
 *
 * It is deliberately NOT offered everywhere this component is. It needs a
 * real `publish_queue` row to update, which exists only after approval; on
 * the pre-approval draft view there is nothing yet to confirm, so `queueRowId`
 * is left undefined there and the control simply does not render.
 */
const INTENT: Record<string, { label: string; url: (text: string) => string; note: string }> = {
  x: {
    label: 'Open X with this filled in',
    url: (t) => `https://x.com/intent/post?text=${encodeURIComponent(t)}`,
    note: 'Opens X’s compose box in your own session. Nothing is posted until you press Post there.',
  },
  /*
   * LINKEDIN GETS NO PREFILL, AND THAT IS THE FIX RATHER THAN A LIMITATION.
   *
   * This used to carry the post in `?shareActive=true&text=…`. Measured on
   * real posts, `encodeURIComponent` expands them about 1.4x — every one of
   * the 20-odd newlines in a LinkedIn post becomes `%0A` — so a 1772-character
   * post became a 2567-character URL, past the 2083 length that legacy stacks
   * cap at and well into where LinkedIn's undocumented `text` parameter stops
   * carrying the whole thing. The composer opened with the post cut off, and
   * nothing said so.
   *
   * Worse, that truncation was the stated reason the LinkedIn length gate was
   * pinned at 1000 characters, which cost every post 15-25% of itself to a
   * limit LinkedIn does not have. Fixing it here is what let the gate move to
   * LinkedIn's real 3000.
   *
   * So the composer opens empty and the text comes from the clipboard. One
   * extra keystroke, and the whole post arrives.
   */
  linkedin: {
    label: 'Open LinkedIn',
    url: () => 'https://www.linkedin.com/feed/?shareActive=true',
    note: 'Copy the text first, then paste it into the composer. LinkedIn cannot be pre-filled '
      + 'reliably — a long post arrives cut off — so it is opened empty on purpose.',
  },
};

export default function PostManually({
  channel, body, reason, queueRowId,
}: {
  channel: string; body: string; reason?: string;
  /** The publish_queue row this control can confirm. Omit to hide "I posted this". */
  queueRowId?: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const intent = INTENT[channel];

  async function copy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused outright in some browsers and on any
      // insecure origin. Saying nothing would leave someone clicking a button
      // that silently does not work.
      setCopyFailed(true);
    }
  }

  async function confirmPosted() {
    if (!queueRowId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/queue/${queueRowId}/confirm`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setConfirmError(j?.error?.message ?? 'That could not be recorded.');
        return;
      }
      setConfirm(null);
      router.refresh();
    } catch {
      setConfirmError('That did not reach the server. Nothing was recorded.');
    } finally {
      setConfirming(false);
    }
  }

  function askConfirm() {
    setConfirm({
      title: 'Mark this as posted?',
      confirmLabel: 'Yes, I posted it',
      body: (
        <>
          <p>
            This records that YOU posted it yourself, by name. It is a real fact worth keeping,
            but it is a weaker claim than the system recording a send: there is no message ID
            and nobody here can verify it independently.
          </p>
          <p>Only confirm this once you have actually pressed Post.</p>
        </>
      ),
      onConfirm: confirmPosted,
    });
  }

  return (
    <>
      <div className="rounded-[var(--radius-input)] border border-rule bg-sunk/40 p-3">
        <p className="text-xs font-semibold">Post it yourself, at no cost</p>
        {reason && <p className="mt-1 text-xs text-muted">{reason}</p>}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-quiet h-8 px-3 py-0 text-xs" onClick={copy}>
            {copied ? 'Copied' : 'Copy the text'}
          </button>
          {intent && (
            <a
              className="btn btn-quiet h-8 px-3 py-0 text-xs"
              href={intent.url(body)}
              target="_blank"
              // noreferrer as well as noopener: the target page should not be
              // told which internal screen sent somebody to it.
              rel="noopener noreferrer"
            >
              {intent.label}
            </a>
          )}
          {queueRowId && (
            <button
              type="button"
              className="btn btn-approve h-8 px-3 py-0 text-xs"
              onClick={askConfirm}
              disabled={confirming}
            >
              {confirming ? 'Recording' : 'I posted this'}
            </button>
          )}
        </div>

        {intent && <p className="mt-2 text-xs text-muted">{intent.note}</p>}
        {copyFailed && (
          <p role="alert" className="mt-2 text-xs text-blocking">
            This browser refused clipboard access. Select the text above and copy it by hand.
          </p>
        )}
        {confirmError && (
          <p role="alert" className="mt-2 text-xs text-blocking">{confirmError}</p>
        )}
      </div>

      {queueRowId && (
        <Confirm spec={confirm} busy={confirming} onCancel={() => setConfirm(null)} />
      )}
    </>
  );
}
