'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The escape hatch the revise loop cannot offer itself.
 *
 * `reviseUntilClean` gives up after MAX_REVISIONS passes rather than retry a
 * model that keeps missing the same mark forever — the right call, but it
 * left a genuine dead end: a request stuck at `needs_human` over something
 * as small as an X post 21 characters over the limit, with no way to just
 * fix the 21 characters. This edits the stored asset directly and records
 * it as `origin: 'human_edit'`, a value the history view has always known
 * how to display and no route had ever actually written.
 */
export default function EditAsset({
  requestId, kind, revision, body, maxChars,
}: { requestId: string; kind: string; revision: number; body: string; maxChars?: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const len = [...text].length;
  const over = maxChars != null && len > maxChars;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/assets/${kind}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text, expectedRevision: revision }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error?.message ?? 'The edit could not be saved.');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('The edit did not reach the server. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-quiet mt-3 h-8 px-3 py-0 text-xs"
        onClick={() => { setText(body); setOpen(true); }}
      >
        Edit by hand
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-rule bg-sunk/30 p-3">
      <textarea
        rows={kind === 'x' ? 4 : 8}
        className="field font-mono text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${over ? 'text-blocking font-medium' : 'text-muted'}`}>
          {maxChars != null ? `${len} of ${maxChars}` : `${len} characters`}
        </span>
        <div className="flex gap-2">
          <button
            type="button" className="btn btn-quiet h-8 px-3 py-0 text-xs"
            onClick={() => { setOpen(false); setError(null); }}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button" className="btn btn-approve h-8 px-3 py-0 text-xs"
            onClick={save}
            disabled={busy || !text.trim()}
          >
            {busy ? 'Saving' : 'Save as a new revision'}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-blocking">{error}</p>}
      <p className="mt-2 text-xs text-muted">
        Saved as a new revision, recorded as your edit, not the model's. The deterministic
        checks re-run on it; nothing here re-runs the paid quality judge.
      </p>
    </div>
  );
}
