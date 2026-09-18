'use client';
import { useEffect, useRef } from 'react';

/**
 * The confirmation step for anything that leaves the building.
 *
 * Approving, publishing and sending email are the three actions in this app a
 * person cannot take back. An approval is a named legal record, a published
 * post is on a client's feed, and an email is in somebody's inbox. Each is one
 * click away on a screen full of other clicks, and the cost of the wrong click
 * is nowhere near the cost of confirming it.
 *
 * What makes this worth having, rather than an "are you sure" reflex people
 * learn to click through: the dialog says WHAT WILL HAPPEN, specifically, in
 * the same words the button used. "Approve the x post", plus "this queues it
 * to post on X, which costs $0.20", is a different decision from "Confirm?".
 *
 * The confirm button is deliberately NOT auto-focused. Focus lands on the
 * dialog itself, so the stray Enter or the double-click that opened this
 * cannot also close it.
 */
export type ConfirmSpec = {
  title: string;
  /** What is about to happen, in plain language. One or two short lines. */
  body: React.ReactNode;
  /** The same verb as the button that opened it. "Approve the article". */
  confirmLabel: string;
  tone?: 'go' | 'danger';
  onConfirm: () => void;
};

export default function Confirm({
  spec, busy, onCancel,
}: { spec: ConfirmSpec | null; busy?: boolean; onCancel: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!spec) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under the dialog.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [spec, busy, onCancel]);

  if (!spec) return null;

  return (
    <div
      // A token, not `bg-ink/25`: in dark mode the ink IS near-white, so that
      // would scrim the page with a white wash instead of darkening it.
      style={{ background: 'var(--color-overlay)' }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        tabIndex={-1}
        className="rise sheet w-full max-w-md p-5 shadow-xl outline-none"
      >
        <h2 id="confirm-title" className="text-[15px] font-semibold tracking-[-0.01em]">
          {spec.title}
        </h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-70">{spec.body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${spec.tone === 'danger' ? 'btn-danger' : 'btn-approve'}`}
            onClick={spec.onConfirm}
            disabled={busy}
          >
            {busy ? 'Working' : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
