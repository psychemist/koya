'use client';

import { useRef } from 'react';

/**
 * The confirmation dialog appears in exactly one place: deleting a run.
 *
 * It names the run, the lead count and what goes with it, because "Are you
 * sure?" tells a person nothing they did not already know when they clicked.
 */
export function ConfirmDelete({ runId, objective, leadCount }: {
  runId: string; objective: string; leadCount: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  async function remove() {
    const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/';
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
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="danger" onClick={remove}>Delete the run and its evidence</button>
          <button className="quiet" onClick={() => dialog.current?.close()}>Keep it</button>
        </div>
      </dialog>
    </>
  );
}
