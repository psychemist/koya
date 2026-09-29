'use client';

import { useRef, useState } from 'react';

/**
 * A confirmation that names the consequence (ported from Week 5). "Are you
 * sure?" tells a person nothing they did not know when they clicked; the body
 * says what changes and what does not. Both buttons go dead while the action
 * runs, and a refusal says what happened instead of leaving the dialog open
 * and silent.
 */
export function ConfirmButton({ label, title, body, confirmLabel, cancelLabel, onConfirm, className = 'rp-btn rp-btn-quiet' }: {
  label: string; title: string; body: string; confirmLabel: string; cancelLabel: string;
  onConfirm: () => Promise<string | null>; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const failure = await onConfirm();
      if (failure) setError(failure); else dialog.current?.close();
    } catch { setError('Nothing changed, because the server did not respond.'); }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => { setError(null); dialog.current?.showModal(); }}>{label}</button>
      <dialog ref={dialog} className="rp-dialog" aria-labelledby="rp-dialog-title">
        <h2 id="rp-dialog-title">{title}</h2>
        <p>{body}</p>
        {error && <p className="rp-status" data-tone="bad" role="alert">{error}</p>}
        <div className="rp-row">
          <button type="button" className="rp-btn" onClick={run} disabled={busy}>{busy ? `${confirmLabel}…` : confirmLabel}</button>
          <button type="button" className="rp-btn rp-btn-quiet" onClick={() => dialog.current?.close()} disabled={busy}>{cancelLabel}</button>
        </div>
      </dialog>
    </>
  );
}
