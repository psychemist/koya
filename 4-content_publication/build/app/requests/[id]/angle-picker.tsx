'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Confirm, { type ConfirmSpec } from '@/app/ui/confirm';

/**
 * Human gate 1. Nothing is written until somebody chooses.
 *
 * THE ANGLES DO NOT GO AWAY ONCE ONE IS CHOSEN, and that is the fix this
 * component exists for. The workspace used to render the picker only while
 * `angles.length > 0 && !selected`, so the instant a draft existed the other
 * two outlines became unreachable. Opus had been paid to produce three, the
 * screen had asked a person to compare them, and two of them could then only
 * ever be read. "That angle was the wrong one" is the single most ordinary
 * thing a review produces, and the interface had no answer to it short of
 * raising the whole request again.
 *
 * So after a draft exists the panel stays, collapsed to a summary with the
 * chosen one marked. Rewriting is offered on any of the three, including the
 * one already written, because rewriting the same angle is how somebody
 * responds to a draft that came out thin.
 *
 * The three arrive in RANDOMISED order from the server. Position bias is
 * documented in model judges and it is not unique to models: a fixed order
 * nudges a person towards the first option too. The order is fixed once they
 * are stored, so it does not reshuffle under somebody mid-comparison.
 */
export default function AnglePicker({
  requestId, angles, hasDraft, canWrite, whyNot,
}: {
  requestId: string;
  angles: any[];
  /** Has anything been written yet? Changes the whole shape of this panel. */
  hasDraft: boolean;
  canWrite: boolean;
  whyNot?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [expanded, setExpanded] = useState(!hasDraft);

  const selected = angles.find((a) => a.selected_at);

  async function choose(angleId: string) {
    setConfirm(null);
    setBusy(angleId);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ angleId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(
          `${j?.error?.message ?? 'Writing did not complete.'}` +
          (j?.error?.correlationId ? ` Reference ${j.error.correlationId}.` : ''),
        );
        // The server winds the request back to this screen on failure, so the
        // fresh state and the failure banner above have to be picked up.
        router.refresh();
        return;
      }
      router.refresh();
    } catch {
      setError('The request did not reach the server. Nothing was written.');
    } finally {
      setBusy(null);
    }
  }

  function ask(a: any) {
    const rewriting = hasDraft;
    const sameAngle = selected && a.id === selected.id;

    setConfirm({
      title: rewriting
        ? sameAngle ? 'Write this angle again?' : 'Write a different angle?'
        : 'Write this one?',
      confirmLabel: rewriting ? 'Write it again' : 'Write it',
      tone: rewriting ? 'danger' : 'go',
      body: (
        <>
          <p>
            Claude writes the article on <strong>{a.title}</strong>, then adapts it for every
            channel on the request and runs the checks. It takes two to three minutes and
            costs around thirty cents.
          </p>
          {rewriting ? (
            <>
              <p>
                This writes a new revision of every asset. Nothing is deleted: each previous
                revision stays in the history, and you can read them side by side on the
                review screen.
              </p>
              {/* The specific consequence, named. "Are you sure" is a reflex
                  people learn to click through; "the approval you already gave
                  stops applying" is a decision. */}
              <p className="text-advisory">
                Any approval already given stops applying, because an approval names the exact
                revision it was given for. Whatever is approved has to be approved again.
              </p>
            </>
          ) : (
            <p>The other two angles stay available if this one turns out wrong.</p>
          )}
        </>
      ),
      onConfirm: () => choose(a.id),
    });
  }

  return (
    <>
      <section className={hasDraft ? 'sheet overflow-hidden' : undefined}>
        {hasDraft ? (
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunk/40"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {selected ? selected.title : 'Angles'}
              </span>
              <span className="block truncate text-xs text-muted">
                {selected
                  ? `Being written. Targeting ${selected.primary_keyword}.`
                  : 'None selected.'}
                {angles.length > 1 && ` ${angles.length - 1} other angle${
                  angles.length === 2 ? '' : 's'} available.`}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted">
              {expanded ? 'Hide' : 'Change the angle'}
            </span>
            <span
              aria-hidden="true"
              className={`shrink-0 text-faint transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              <svg width="8" height="10" viewBox="0 0 8 10">
                <path d="M1 1 6 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
          </button>
        ) : (
          <>
            <h2 className="text-sm font-semibold">Pick an angle</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Three outlines, not three articles. Writing two to throw away would cost three
              times as much for a decision the outline already settles. They are shown in
              random order.
            </p>
          </>
        )}

        {expanded && (
          <div className={hasDraft ? 'border-t border-rule bg-sunk/20 p-4' : 'mt-3.5'}>
            {hasDraft && (
              <p className="mb-3 max-w-3xl text-xs text-muted">
                Writing any of these produces a new revision of every asset. Nothing is
                deleted, and any approval already given stops applying, because an approval
                names the revision it was given for.
              </p>
            )}

            {/* Three equal columns across the full page width, so each outline
                gets a measure long enough for its headings to read as headings
                rather than as stacks of two-word fragments. */}
            <div className="grid gap-4 md:grid-cols-3">
              {angles.map((a) => {
                const thin = a.keyword_class === 'supporting';
                const isSelected = selected && a.id === selected.id;
                return (
                  <div
                    key={a.id}
                    className={`sheet flex flex-col p-4 ${
                      isSelected ? 'border-ok/40 ring-1 ring-ok/25' : ''}`}
                  >
                    {isSelected && (
                      <span className="pill mb-2 self-start bg-ok-bg text-ok">
                        <span className="pill-dot" />
                        This is the one written
                      </span>
                    )}
                    <h3 className="font-medium leading-snug">{a.title}</h3>
                    <p className="mt-1.5 flex-1 text-sm text-ink-70">{a.thesis}</p>

                    <p className="mt-3 text-sm">
                      <span className="text-muted">Targets </span>
                      <strong className="font-medium">{a.primary_keyword}</strong>
                    </p>
                    {thin && (
                      <p className="mt-1 text-xs text-advisory">
                        A supporting long-tail keyword. It belongs inside a broader article
                        rather than carrying one, so this angle cannot be written.
                      </p>
                    )}

                    {(a.outline ?? []).length > 0 && (
                      <ol className="mt-2.5 space-y-1 text-xs text-muted">
                        {(a.outline ?? []).map((s: any, i: number) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-faint tabular-nums">{i + 1}</span>
                            <span>{s.heading}</span>
                          </li>
                        ))}
                      </ol>
                    )}

                    <button
                      className={`btn mt-4 ${isSelected ? 'btn-quiet' : 'btn-primary'}`}
                      onClick={() => ask(a)}
                      disabled={Boolean(busy) || thin || !canWrite}
                      title={
                        thin ? 'Building a whole article on a supporting keyword is thin content'
                        : !canWrite ? whyNot : undefined
                      }
                    >
                      {busy === a.id ? 'Writing and checking'
                        : !hasDraft ? 'Write this one'
                        : isSelected ? 'Write it again'
                        : 'Write this one instead'}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* A disabled button with no reason is a dead end. */}
            {!canWrite && whyNot && (
              <p className="mt-3 text-sm text-muted">{whyNot}</p>
            )}
            {busy && (
              <p className="mt-3 text-sm text-muted">
                Writing the article, adapting it for each channel, then running the checks.
                This takes a few minutes. Leaving the page does not stop it, and the panel at
                the top of the page tracks it.
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-blocking">{error}</p>
            )}
          </div>
        )}
      </section>

      <Confirm spec={confirm} busy={Boolean(busy)} onCancel={() => setConfirm(null)} />
    </>
  );
}
