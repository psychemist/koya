'use client';

import { useRef, useState } from 'react';

/**
 * The confirmation dialog appears in exactly one place: deleting a run.
 *
 * It names the run, the lead count and what goes with it, because "Are you
 * sure?" tells a person nothing they did not already know when they clicked.
 *
 * A refused delete used to do nothing at all: the dialog sat there and the
 * person clicked again. It says what happened now, which is also what makes
 * disabling the button safe.
 */
export function ConfirmDelete({ runId, objective, leadCount }: {
  runId: string; objective: string; leadCount: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
      // Deliberately still disabled on the way out. The navigation takes a
      // moment, and a second click in that moment is a second delete.
      if (res.ok) { window.location.href = '/'; return; }
      setError((await res.json().catch(() => ({}))).error ?? 'The run was not deleted.');
    } catch {
      setError('The server did not respond, so nothing was deleted.');
    }
    setDeleting(false);
  }

  return (
    <>
      <button className="quiet" onClick={() => dialog.current?.showModal()}>
        Delete this run
      </button>

      <dialog ref={dialog}>
        <h2>Delete this run</h2>
        <p className="small">{objective}</p>
        <p className="small">
          This permanently deletes {leadCount} {leadCount === 1 ? 'lead' : 'leads'} with their
          drafts, the scraped pages they were judged from, and the tool-call log that shows how
          the run spent its budget. It cannot be undone.
        </p>
        {error && <div className="error small" style={{ marginTop: 14 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          {/* Both controls go dead while the delete is in flight. The work is
              irreversible, so a second click, or a dismissal that leaves the
              request running unseen, are both worth spending a disabled
              button on. Escape still closes the dialog. */}
          <button className="danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting the run' : 'Delete the run and its evidence'}
          </button>
          <button className="quiet" onClick={() => dialog.current?.close()} disabled={deleting}>
            Keep it
          </button>
        </div>
      </dialog>
    </>
  );
}
