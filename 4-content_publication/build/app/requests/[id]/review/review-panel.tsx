'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Confirm, { type ConfirmSpec } from '@/app/ui/confirm';
import { usePersisted } from '@/app/ui/use-persisted';
import { esc, markBody } from '@/app/ui/mark-body';

type Decision = 'approved' | 'changes_requested' | 'rejected';

export const KIND_LABEL: Record<string, string> = {
  article: 'Article', linkedin: 'LinkedIn post', x: 'X post', newsletter: 'Newsletter',
};

/**
 * Human gate 2, and the screen that has to justify itself legally.
 *
 * Article 50 of the EU AI Act lifts the labelling duty for AI-generated text
 * only where a human review has taken place, "provided such checks are
 * substantive and not limited to superficial matters or cursory approval". A
 * one-click Approve cannot be SHOWN to be substantive.
 *
 * So the proof and the evidence sit side by side: the draft with unsupported
 * claims struck in place, the counts, the judge's per-criterion scores, the
 * full revision history and the sources that were thrown out. The hash of
 * exactly that bundle is stored with the approval, and the server recomputes
 * it before accepting.
 *
 * The margin is TABBED. Findings, judge, history and sources were a single
 * stacked column beside the proof, so the judge's nine criteria pushed the
 * source list off the bottom and the history had nowhere to go at all. They
 * are four different questions and nobody asks two at once.
 */
export default function ReviewPanel(props: {
  requestId: string; kind: string; hash: string; version: number;
  bundle: any;
  citations: Record<string, string>;
  actorName: string;
  refusals: Record<Decision, string | null>;
  history: any[];
  decisions: any[];
  publishesToX: boolean;
  xIncludesLink: boolean;
}) {
  const router = useRouter();
  const { asset, claims, evaluations, flags, sources } = props.bundle;

  // The note survives a refresh. Someone writing three careful sentences
  // about why a draft is going back should not lose them to a stray reload.
  const { value: note, setValue: setNote, clear: clearNote } =
    usePersisted(`review-note:${props.requestId}:${props.kind}`, '');

  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [tab, setTab] = useState<'findings' | 'judge' | 'history' | 'sources'>('findings');
  const [waivingId, setWaivingId] = useState<string | null>(null);
  const [waiveError, setWaiveError] = useState<string | null>(null);

  const blocking = flags.filter((f: any) => f.severity === 'blocking' && f.status === 'open');
  const unsupported = claims.filter((c: any) => c.status === 'unsupported');
  const supported = claims.length - unsupported.length;
  const tier1 = evaluations.filter((e: any) => e.tier === 1);

  /**
   * An article nobody has judged is not an article that passed.
   *
   * Tier 0 runs on every asset and is deterministic; Tier 1 is the model judge
   * and it reads the ARTICLE only. With no Tier 1 rows, "no blocking findings"
   * means the question was never asked — which looks identical on screen to
   * having been asked and answered well. The route refuses this too; this is
   * the screen saying so first, in the same words.
   *
   * The channel posts are a different case entirely and must not be caught by
   * this: they are never judged by design, so requiring a score would make
   * them permanently unapprovable.
   */
  const unjudged = props.kind === 'article' && tier1.length === 0;
  const quarantined = sources.filter((s: any) => s.quarantined);
  const label = KIND_LABEL[props.kind] ?? props.kind;

  const approved = props.decisions.find((d: any) => d.decision === 'approved');
  const staleApproval = approved && approved.asset_revision !== asset.revision;
  /**
   * Not just "was there ever an approval at this revision" — `decisions` is
   * newest-first, so the FIRST one found for this revision is the one that
   * actually stands. Sending a since-approved revision back for changes, or
   * rejecting it, is the withdrawal path: it adds a newer decision without
   * erasing the old one from the record, and that newer decision is what
   * should bring the Approve button back.
   */
  const latestForRevision = props.decisions.find((d: any) => d.asset_revision === asset.revision);
  const isApprovedNow = latestForRevision?.decision === 'approved';

  async function decide(decision: Decision) {
    setConfirm(null);
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${props.requestId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: props.kind, decision, note: note.trim() || undefined,
          evidenceHash: props.hash, expectedVersion: props.version,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(
          `${j?.error?.message ?? 'The decision was not recorded.'}` +
          (j?.error?.correlationId ? ` Reference ${j.error.correlationId}.` : ''),
        );
        return;
      }
      clearNote();       // it has been sent, so it is no longer a draft
      router.refresh();
    } catch {
      setError('The decision did not reach the server. Nothing was recorded.');
    } finally {
      setBusy(null);
    }
  }

  async function waive(flagId: string, reason: string) {
    setWaivingId(flagId);
    setWaiveError(null);
    try {
      const res = await fetch(`/api/requests/${props.requestId}/flags/${flagId}/waive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setWaiveError(
          `${j?.error?.message ?? 'The waiver was not recorded.'}` +
          (j?.error?.correlationId ? ` Reference ${j.error.correlationId}.` : ''),
        );
        return;
      }
      // The evidence hash covers open flags, so a waived one changes it —
      // the same reload the approve route already demands after any other
      // change made while this screen was open.
      router.refresh();
    } catch {
      setWaiveError('The waiver did not reach the server. Nothing was recorded.');
    } finally {
      setWaivingId(null);
    }
  }

  /**
   * Every one of these three is irreversible in a different direction, so each
   * confirmation names the specific thing that is about to happen rather than
   * asking whether the person is sure.
   */
  function ask(decision: Decision) {
    if (decision === 'approved') {
      const publishes = props.kind !== 'article';
      setConfirm({
        title: `Approve the ${label.toLowerCase()}?`,
        confirmLabel: `Approve the ${label.toLowerCase()}`,
        body: (
          <>
            <p>
              This records that <strong>{props.actorName}</strong> reviewed revision{' '}
              {asset.revision} with the evidence on this page in front of you. The record
              keeps the fingerprint of exactly what you were shown.
            </p>
            {publishes ? (
              <p>
                It also queues the {label.toLowerCase()} for publishing. Once the queue runs,
                it is out. The citation markers are removed at that point; nothing else in the
                text changes.
              </p>
            ) : (
              <p>
                The article is not published anywhere. It is the source the channel posts are
                written from.
              </p>
            )}
            {props.kind === 'x' && (
              <p className="text-advisory">
                {props.publishesToX
                  ? props.xIncludesLink
                    ? 'This request opted into paid X posting and keeps the link, so X bills $0.20 for this post.'
                    : 'This request opted into paid X posting without the link, so X bills $0.015. The link is removed just before posting and the approved text is not changed.'
                  : 'This request did not opt into paid X posting, so nothing is charged and nothing posts automatically. The queue keeps the text for somebody to post by hand.'}
              </p>
            )}
          </>
        ),
        onConfirm: () => decide('approved'),
      });
      return;
    }

    setConfirm({
      title: decision === 'rejected'
        ? `Reject the ${label.toLowerCase()}?`
        : 'Send this back for changes?',
      confirmLabel: decision === 'rejected' ? 'Reject it' : 'Send it back',
      tone: 'danger',
      body: decision === 'rejected' ? (
        <>
          <p>This closes the {label.toLowerCase()} off. The author is told, with your note.</p>
          <p>The draft and its history are kept, but nothing here will be published.</p>
        </>
      ) : (
        <>
          <p>The author is told, with your note, and the draft goes back for another pass.</p>
          <p>Nothing is published in the meantime.</p>
        </>
      ),
      onConfirm: () => decide(decision),
    });
  }

  const TABS = [
    { key: 'findings' as const, label: 'Findings',
      count: blocking.length + unsupported.length,
      tone: blocking.length ? 'blocking' : undefined },
    { key: 'judge' as const, label: 'Judge', count: tier1.length },
    { key: 'history' as const, label: 'History', count: props.history.length },
    { key: 'sources' as const, label: 'Sources', count: sources.length,
      tone: quarantined.length ? 'blocking' : undefined },
  ];

  return (
    <>
      <section className="sheet overflow-hidden">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-sunk/40 px-4 py-3">
          <h2 className="text-sm font-semibold">{label}</h2>
          <span className="text-xs text-muted">revision {asset.revision}</span>

          {approved && (
            <span className={`pill ${staleApproval ? 'bg-blocking-bg text-blocking' : 'bg-ok-bg text-ok'}`}>
              {staleApproval
                ? `Approved at revision ${approved.asset_revision}, edited since, so that approval is void`
                : `Approved at revision ${approved.asset_revision} by ${approved.actor}`}
            </span>
          )}

          {/*
            Plain links, not fetch-and-blob buttons. The browser already knows
            how to download a file from a URL, and doing it by hand means
            holding the whole PDF in memory to build an object URL that then
            has to be revoked. `download` is belt and braces over the
            Content-Disposition the route already sends.

            Article only: the channel posts are short enough to select and
            copy, and a one-page PDF of a 280-character X post is furniture
            around nothing.
          */}
          {props.kind === 'article' && (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-muted">Download</span>
              <a
                className="btn btn-quiet h-6 px-2 py-0 text-xs"
                href={`/api/requests/${props.requestId}/article/download?format=md`}
                download
              >
                Markdown
              </a>
              <a
                className="btn btn-quiet h-6 px-2 py-0 text-xs"
                href={`/api/requests/${props.requestId}/article/download?format=pdf`}
                download
              >
                PDF
              </a>
            </span>
          )}

          <span
            className="ident ml-auto"
            title="A fingerprint of the evidence rendered on this page. Stored with your decision, and recomputed by the server before it is accepted."
          >
            evidence {props.hash.slice(0, 12)}
          </span>
        </header>

        <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {/* The proof. */}
          <div className="border-b border-rule px-5 py-5 lg:border-b-0 lg:border-r">
            <Proof
              body={asset.body} unsupported={unsupported.map((c: any) => c.text)}
              citations={props.citations}
            />
            {asset.subject_line && (
              <p className="mt-5 border-t border-rule pt-3 text-sm">
                <span className="text-muted">Subject line: </span>
                {asset.subject_line}
              </p>
            )}
          </div>

          {/* The margin. */}
          <aside className="min-w-0">
            <div role="tablist" aria-label={`${label} evidence`} className="flex border-b border-rule">
              {TABS.map((t) => {
                const on = t.key === tab;
                return (
                  <button
                    key={t.key}
                    role="tab"
                    type="button"
                    aria-selected={on}
                    onClick={() => setTab(t.key)}
                    className={`-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-xs transition-colors ${
                      on ? 'border-ink font-semibold text-ink'
                         : 'border-transparent text-muted hover:text-ink'}`}
                  >
                    {t.label}
                    {t.count > 0 && (
                      <span className={`pill tabular-nums ${
                        t.tone === 'blocking' ? 'bg-blocking-bg text-blocking' : 'bg-sunk text-ink-70'}`}>
                        {t.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="px-4 py-4 text-sm">
              {tab === 'findings' && (
                <Findings
                  blocking={blocking} unsupported={unsupported} supported={supported}
                  onWaive={waive} waivingId={waivingId} waiveError={waiveError}
                />
              )}
              {tab === 'judge' && <Judge scores={tier1} kind={props.kind} />}
              {tab === 'history' && (
                <History
                  rows={props.history} current={asset.revision} decisions={props.decisions}
                  citations={props.citations}
                />
              )}
              {tab === 'sources' && <SourceList rows={sources} />}
            </div>
          </aside>
        </div>

        <div className="border-t border-rule px-4 py-4">
          <label htmlFor={`note-${props.kind}`} className="label">
            Note for the author{' '}
            <span className="hint">required to send it back or reject it, kept if you refresh</span>
          </label>
          <textarea
            id={`note-${props.kind}`} rows={2} className="field"
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What has to change, and why."
          />

          {error && <p role="alert" className="mt-2.5 text-sm text-blocking">{error}</p>}

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <button
              className="btn btn-approve"
              onClick={() => ask('approved')}
              disabled={
                isApprovedNow || Boolean(busy) || Boolean(props.refusals.approved)
                || blocking.length > 0 || unjudged
              }
            >
              {isApprovedNow ? 'Approved'
                : busy === 'approved' ? 'Approving' : `Approve the ${label.toLowerCase()}`}
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => ask('changes_requested')}
              disabled={Boolean(busy) || Boolean(props.refusals.changes_requested) || !note.trim()}
            >
              Send back for changes
            </button>
            <button
              className="btn btn-danger"
              onClick={() => ask('rejected')}
              disabled={Boolean(busy) || Boolean(props.refusals.rejected) || !note.trim()}
            >
              Reject
            </button>
          </div>

          {/* A disabled button with no reason is a dead end. Each reason is
              named, in priority order, so the person knows what to do next.
              The role refusal comes first now: telling somebody to resolve
              fourteen findings before mentioning that they could not approve
              this in any case is the wrong order to learn it in. */}
          {isApprovedNow ? (
            <p className="mt-2.5 text-sm text-muted">
              This revision is already approved by {latestForRevision.actor}. Sending it back or
              rejecting it withdraws that and brings Approve back.
            </p>
          ) : props.refusals.approved && props.refusals.changes_requested ? (
            <p className="mt-2.5 text-sm text-muted">{props.refusals.changes_requested}</p>
          ) : unjudged ? (
            /*
             * Ahead of the blocking-findings reason, deliberately. If the judge
             * never ran, the finding count is not evidence that the draft is
             * clean — it is evidence that only the mechanical half of the
             * checks happened. Naming the findings first would tell somebody
             * to go and resolve nothing.
             */
            <p className="mt-2.5 text-sm text-muted">
              <strong className="font-semibold text-ink">The judge has not scored this revision.</strong>{' '}
              The deterministic checks ran, but nothing has read the article for quality, so
              there is no verdict to approve against. An empty findings list here means the
              question was not asked, not that the answer was good. This is the normal state
              straight after a hand edit, which re-runs the mechanical checks and not the
              judge. Re-run the checks to get a score, or send it back.
            </p>
          ) : blocking.length > 0 ? (
            <p className="mt-2.5 text-sm text-muted">
              Approval is refused while something blocks it. The draft has to be revised, or
              each blocking finding waived with a written reason. Sending it back does not
              need that.
            </p>
          ) : props.refusals.approved ? (
            <p className="mt-2.5 text-sm text-muted">{props.refusals.approved}</p>
          ) : !note.trim() ? (
            <p className="mt-2.5 text-sm text-muted">
              Sending it back or rejecting it needs a note. Approving does not.
            </p>
          ) : null}
        </div>
      </section>

      <Confirm spec={confirm} busy={Boolean(busy)} onCancel={() => setConfirm(null)} />
    </>
  );
}

/* -------------------------------------------------------------- findings */

function Findings({ blocking, unsupported, supported, onWaive, waivingId, waiveError }: {
  blocking: any[]; unsupported: any[]; supported: number;
  onWaive: (flagId: string, reason: string) => void;
  waivingId: string | null;
  waiveError: string | null;
}) {
  return (
    <div className="space-y-5">
      {blocking.length > 0 && (
        <div>
          <h3 className="font-semibold text-blocking">
            {blocking.length === 1
              ? 'One thing blocks approval'
              : `${blocking.length} things block approval`}
          </h3>
          <ul className="mt-1.5 space-y-2 text-ink-70">
            {blocking.map((f: any) => (
              <li key={f.id} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blocking" />
                <div className="min-w-0 flex-1">
                  <span>{f.message}</span>
                  <FlagWaiver
                    busy={waivingId === f.id}
                    onWaive={(reason) => onWaive(f.id, reason)}
                  />
                </div>
              </li>
            ))}
          </ul>
          {waiveError && <p role="alert" className="mt-2 text-xs text-blocking">{waiveError}</p>}
        </div>
      )}

      <div>
        <h3 className="font-semibold">Claims traced to a source</h3>
        <p className="mt-1">
          <span className="text-ok">{supported} supported</span>
          {', '}
          <span className={unsupported.length ? 'text-blocking' : 'text-muted'}>
            {unsupported.length} with no source
          </span>
        </p>
        {unsupported.length > 0 && (
          <>
            <p className="mt-1 text-xs text-muted">Marked in the draft where they appear.</p>
            <ul className="mt-1.5 space-y-1 text-xs text-blocking">
              {unsupported.slice(0, 10).map((c: any, i: number) => (
                <li key={i}>{c.text}</li>
              ))}
              {unsupported.length > 10 && (
                <li className="text-muted">and {unsupported.length - 10} more</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Waiving is a decision, not a click: the reason is typed before the button
 * that acts on it exists, the same shape as the note required to send a
 * draft back. It collapses again on success because the flag it belonged to
 * is no longer open once the page reloads.
 */
function FlagWaiver({ busy, onWaive }: { busy: boolean; onWaive: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 block text-xs font-medium text-muted underline hover:text-ink"
        onClick={() => setOpen(true)}
        disabled={busy}
      >
        Waive this finding
      </button>
    );
  }

  return (
    <div className="mt-1.5 max-w-md space-y-1.5">
      <textarea
        rows={2}
        className="field text-xs"
        placeholder="Why is it safe to waive this? Required, and kept on the record."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      <div className="flex gap-2">
        <button
          type="button" className="btn btn-quiet"
          onClick={() => { setOpen(false); setReason(''); }}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button" className="btn btn-danger"
          disabled={busy || !reason.trim()}
          onClick={() => onWaive(reason.trim())}
        >
          {busy ? 'Waiving' : 'Waive with this reason'}
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- judge */

/**
 * The judge's scorecard.
 *
 * It was a list of "criterion ....... 3 of 5" rows. Nine of them read as a
 * wall of numbers with no shape: nothing showed which were weak at a glance,
 * and the required_action, which is the only part that tells a reviewer what
 * to do, was not rendered at all.
 *
 * So: an average with the same colour rule as everything else, then a meter
 * per criterion. Five segments rather than a proportional bar, because the
 * scale IS five discrete points and a smooth bar implies a precision the
 * judge does not have. The weak ones open to show the evidence and the action;
 * the ones that passed stay one line each, because a reviewer scanning nine
 * criteria is looking for the two that did not.
 */
function Judge({ scores, kind }: { scores: any[]; kind: string }) {
  if (scores.length === 0) {
    /*
     * TWO DIFFERENT EMPTY STATES WEARING ONE SENTENCE.
     *
     * This said "the judge has not scored this asset" everywhere, which on a
     * channel tab describes the permanent, intended arrangement and on the
     * article describes a request that cannot be approved. Three of the four
     * tabs are channels, so the sentence people saw most was the one that
     * meant nothing was wrong — and it was the same sentence shown when
     * something was.
     */
    return kind === 'article' ? (
      <div className="rounded-md border border-advisory/25 bg-advisory-bg p-3 text-sm">
        <p className="font-semibold text-advisory">This revision has not been judged.</p>
        <p className="mt-1.5 text-ink-70">
          Approval is refused until it has been. The deterministic checks have run, but nothing
          has read this revision for quality, so an empty findings list here is the absence of a
          question rather than a clean answer. A hand edit leaves an article in exactly this
          state: it re-runs the mechanical checks and not the judge, because the judge costs
          money to run and a typo fix does not need one.
        </p>
      </div>
    ) : (
      <p className="text-muted">
        The judge reads the article only, so there is no score here and there is not meant to
        be. This {kind === 'x' ? 'post' : kind === 'newsletter' ? 'newsletter' : 'post'} is
        checked mechanically against its own rules — length, structure, the call to action —
        and those results are under Findings.
      </p>
    );
  }

  const avg = scores.reduce((n, e) => n + (e.score ?? 0), 0) / scores.length;
  const weak = scores.filter((e) => (e.score ?? 5) <= 3);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-semibold">Judge score</h3>
          <span className={`text-lg font-semibold tabular-nums ${toneFor(avg)}`}>
            {avg.toFixed(1)}
            <span className="text-sm font-normal text-muted"> of 5</span>
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          Scored by Haiku, a different model from the one that wrote it, because judges
          measurably favour their own work. It never sees the revision number or its own
          previous scores.
        </p>
        {weak.length > 0 && (
          <p className="mt-1.5 text-xs text-advisory">
            {weak.length} of {scores.length} scored 3 or below. Those are expanded.
          </p>
        )}
      </div>

      <ul className="space-y-2.5">
        {scores.map((e: any, i: number) => {
          const score = e.score ?? 0;
          const low = score <= 3;
          return (
            <li key={i} className={low ? 'rounded-md bg-sunk/60 p-2.5' : ''}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] capitalize">
                  {String(e.criterion).replace(/_/g, ' ')}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Meter score={score} />
                  <span className={`w-6 text-right text-[13px] font-semibold tabular-nums ${toneFor(score)}`}>
                    {score}
                  </span>
                </span>
              </div>

              {low && (
                <div className="mt-1.5 space-y-1 text-xs">
                  {e.evidence && <p className="text-ink-70">{e.evidence}</p>}
                  {e.required_action && (
                    <p className="text-muted">
                      <span className="font-medium text-ink-70">To fix: </span>
                      {e.required_action}
                    </p>
                  )}
                </div>
              )}
              {!low && e.evidence && (
                <p className="mt-0.5 truncate text-xs text-muted" title={e.evidence}>
                  {e.evidence}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Five segments, because the scale is five discrete points and not a range. */
function Meter({ score }: { score: number }) {
  return (
    <span className="flex gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-3 w-1.5 rounded-[1px] ${
            n > score ? 'bg-rule'
            : score <= 2 ? 'bg-blocking'
            : score === 3 ? 'bg-advisory'
            : 'bg-ok'}`}
        />
      ))}
    </span>
  );
}

const toneFor = (score: number) =>
  score <= 2 ? 'text-blocking' : score <= 3 ? 'text-advisory' : 'text-ok';

/* --------------------------------------------------------------- history */

/**
 * Every revision this asset has ever had, and every decision taken on it.
 *
 * The screen showed one revision number and nothing else, so the three
 * mechanisms this system is proudest of were all invisible: that a revision
 * pass which scored worse gets rolled back, that each revision records what it
 * cost, and that an approval names the exact revision it applies to and is
 * voided by the next one.
 *
 * A reviewer looking at revision 3 with fourteen findings cleared cannot tell
 * whether that took one careful pass or three flailing ones. That is exactly
 * the judgement "substantive rather than cursory" is supposed to rest on.
 */
function History({ rows, current, decisions, citations }: {
  rows: any[]; current: number; decisions: any[]; citations: Record<string, string>;
}) {
  const [open, setOpen] = useState<number | null>(null);

  if (rows.length === 0) return <p className="text-muted">No revisions recorded.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {rows.length === 1
          ? 'One revision. Nothing has been rewritten.'
          : `${rows.length} revisions, newest first. Every one is kept: a revision pass that scored worse is rolled back rather than deleted.`}
      </p>

      <ol className="space-y-2">
        {rows.map((h: any) => {
          const isOpen = open === h.revision;
          const decision = decisions.find((d: any) => d.asset_revision === h.revision);
          return (
            <li key={h.revision} className={`rounded-md border ${
              h.revision === current ? 'border-ink/25 bg-sunk/50' : 'border-rule'}`}>
              <button
                type="button"
                className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : h.revision)}
              >
                <span className="mt-0.5 w-6 shrink-0 text-xs font-semibold tabular-nums text-muted">
                  r{h.revision}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">
                    {originLabel(h.origin)}
                    {h.revision === current && (
                      <span className="ml-1.5 font-normal text-muted">current</span>
                    )}
                  </span>
                  <span className="block text-xs text-muted">
                    {new Date(h.created_at).toLocaleString()}
                    {h.author ? ` · ${h.author}` : ''}
                    {h.avg_score ? ` · judged ${Number(h.avg_score).toFixed(1)} of 5` : ''}
                    {h.cost_usd ? ` · $${Number(h.cost_usd).toFixed(3)}` : ''}
                  </span>
                  {decision && (
                    <span className={`pill mt-1 ${
                      decision.decision === 'approved' ? 'bg-ok-bg text-ok'
                      : decision.decision === 'rejected' ? 'bg-blocking-bg text-blocking'
                      : 'bg-advisory-bg text-advisory'}`}>
                      {decisionLabel(decision.decision)} by {decision.actor}
                    </span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={`mt-1 shrink-0 text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}
                >
                  <svg width="7" height="9" viewBox="0 0 8 10">
                    <path d="M1 1 6 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-rule px-2.5 py-2.5">
                  {decision?.note && (
                    <p className="mb-2 rounded bg-sunk/70 p-2 text-xs text-ink-70">
                      <span className="font-medium">Note from {decision.actor}: </span>
                      {decision.note}
                    </p>
                  )}
                  {h.subject_line && (
                    <p className="mb-2 text-xs">
                      <span className="text-muted">Subject: </span>{h.subject_line}
                    </p>
                  )}
                  <div
                    className="max-h-80 overflow-y-auto rounded border border-rule bg-sheet p-2.5 text-xs leading-relaxed"
                    // Same marking as the proof, so a citation marker in an old
                    // revision reads as apparatus here too rather than as text.
                    dangerouslySetInnerHTML={{
                      __html: markBody(esc(String(h.body ?? '')), [], citations),
                    }}
                  />
                  {h.model && <p className="ident mt-1.5">{h.model}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const originLabel = (o: string) =>
  ({ generate: 'First draft', auto_revise: 'Revised after the checks',
     human_edit: 'Edited by a person', revert: 'Reverted to the better version' }[o] ?? o);

const decisionLabel = (d: string) =>
  ({ approved: 'Approved', changes_requested: 'Sent back', rejected: 'Rejected' }[d] ?? d);

/* --------------------------------------------------------------- sources */

function SourceList({ rows }: { rows: any[] }) {
  const quarantined = rows.filter((s: any) => s.quarantined);
  return (
    <div className="space-y-3">
      {quarantined.length > 0 && (
        <div className="rounded-md border border-blocking/25 bg-blocking-bg p-2.5">
          <h3 className="text-xs font-semibold text-blocking">
            {quarantined.length === 1
              ? 'One source was quarantined'
              : `${quarantined.length} sources were quarantined`}
          </h3>
          <p className="mt-1 text-xs text-ink-70">
            Prompt injection markers were found in them. They were kept out of the excerpt
            pool, so nothing in this draft rests on them.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {rows.map((s: any, i: number) => (
          <li key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3">
            <span className={`pill justify-center ${
              s.quarantined ? 'bg-blocking-bg text-blocking'
              : s.fetch_status === 'ok' ? 'bg-ok-bg text-ok'
              : 'bg-advisory-bg text-advisory'}`}>
              {s.quarantined ? 'Out' : s.fetch_status === 'ok' ? 'Used' : 'Failed'}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs" title={s.url}>{s.title || s.url}</span>
              <span className="block truncate text-xs text-muted">{s.url}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ proof */

/**
 * Renders the stored body as a proof, with unsupported claims struck in place
 * and citation markers set apart from the prose.
 *
 * The marking itself lives in app/ui/mark-body, shared with the workspace and
 * with the revision history, so one draft never renders three different ways.
 */
function Proof({ body, unsupported, citations }: {
  body: string; unsupported: string[]; citations: Record<string, string>;
}) {
  const blocks = body.split(/\n{2,}/).map((raw, i) => {
    const text = raw.trim();
    if (!text) return null;
    if (text.startsWith('## ')) return <h3 key={i} className="t-h2">{text.slice(3)}</h3>;
    if (text.startsWith('# ')) return <h2 key={i} className="t-h1">{text.slice(2)}</h2>;
    return (
      <p
        key={i}
        className="t-p"
        dangerouslySetInnerHTML={{ __html: markBody(esc(text), unsupported, citations) }}
      />
    );
  });

  return <div className="proof">{blocks}</div>;
}
