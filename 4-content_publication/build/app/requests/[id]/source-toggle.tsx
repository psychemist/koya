'use client';
import { useState } from 'react';

/**
 * Overriding which sources feed the excerpt pool.
 *
 * Every excerpt is marked `selected` automatically at extraction time, based
 * on a relevance score nobody sees. This is the human veto on top of it: turn
 * off a source that scored well but that you do not trust, or bring back one
 * that scored just under the line and that you know is actually the best
 * thing in the pile.
 *
 * Disabled once an angle has been written, for the same reason attachments
 * stop uploading at that point: the draft was written from a specific
 * corpus, and changing the corpus under it afterwards would leave citations
 * pointing at excerpts the draft never actually saw.
 */
export default function SourceToggle({
  requestId, sourceId, selected, excerptCount,
}: { requestId: string; sourceId: string; selected: boolean; excerptCount: number }) {
  const [on, setOn] = useState(selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/sources`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId, selected: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error?.message ?? 'That change was not saved.');
        return;
      }
      setOn(next);
    } catch {
      setError('That change did not reach the server. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  }

  if (excerptCount === 0) {
    return <span className="text-xs text-muted">no excerpts pulled from it</span>;
  }

  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--color-ink)]"
          checked={on}
          disabled={busy}
          onChange={toggle}
        />
        <span className={on ? 'text-ink-70' : 'text-muted'}>
          {on ? `Used, ${excerptCount} excerpt${excerptCount === 1 ? '' : 's'}` : 'Not used'}
        </span>
      </label>
      {error && <p role="alert" className="mt-0.5 text-xs text-blocking">{error}</p>}
    </div>
  );
}
