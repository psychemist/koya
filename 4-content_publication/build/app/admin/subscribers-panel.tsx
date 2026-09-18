'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Confirm, { type ConfirmSpec } from '@/app/ui/confirm';

/**
 * The newsletter list.
 *
 * Every send reads this table at dispatch time rather than copying it onto the
 * request at approval, so an unsubscribe between approval and dispatch is
 * honoured. That is the whole reason the list lives here and not on a request.
 */
export default function SubscribersPanel({ rows }: { rows: any[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  async function post(body: unknown, onDone?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/subscribers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error?.message ?? 'That change was not saved.');
        return;
      }
      onDone?.();
      router.refresh();
    } catch {
      setError('That change did not reach the server. Nothing was saved.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  function askStatus(row: any, status: 'active' | 'unsubscribed') {
    setConfirm({
      title: status === 'unsubscribed'
        ? `Unsubscribe ${row.email}?`
        : `Put ${row.email} back on the list?`,
      confirmLabel: status === 'unsubscribed' ? 'Unsubscribe them' : 'Restore them',
      tone: status === 'unsubscribed' ? 'danger' : 'go',
      body: status === 'unsubscribed' ? (
        <>
          <p>They stop receiving every newsletter from the next send onwards.</p>
          <p>
            The row is kept rather than deleted, so if somebody tries to add this address again
            it can be refused with the reason instead of quietly resubscribing them.
          </p>
        </>
      ) : (
        <>
          <p>
            This address asked to be removed. Restoring it puts them back on every future send.
          </p>
          <p className="text-advisory">
            Do this only if they have asked to come back. The action is recorded against your
            name in the audit log.
          </p>
        </>
      ),
      onConfirm: () => post({ action: 'status', id: row.id, status }),
    });
  }

  const active = rows.filter((r) => r.status === 'active');
  const gone = rows.filter((r) => r.status !== 'active');

  return (
    <>
      <section className="sheet overflow-hidden">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule bg-sunk/40 px-4 py-3">
          <h2 className="text-sm font-semibold">Newsletter subscribers</h2>
          <p className="text-xs text-muted">
            {active.length} active
            {gone.length > 0 && `, ${gone.length} unsubscribed`}
          </p>
        </header>

        <div className="border-b border-rule px-4 py-3.5">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              post({ action: 'add', email, name: name || undefined },
                () => { setEmail(''); setName(''); });
            }}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="sub-email" className="label">Email</label>
              <input
                id="sub-email" type="email" required className="field"
                value={email} onChange={(e) => setEmail(e.target.value)}
                autoCapitalize="off" spellCheck={false}
                placeholder="someone@example.com"
              />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor="sub-name" className="label">
                Name <span className="hint">optional</span>
              </label>
              <input
                id="sub-name" className="field"
                value={name} onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" disabled={busy || !email.trim()}>
              {busy ? 'Saving' : 'Add'}
            </button>
          </form>
          {error && <p role="alert" className="mt-2 text-sm text-blocking">{error}</p>}
          <p className="hint mt-2">
            Added by hand is the honest description of this. There is no double opt-in flow, so
            only add addresses that have asked to be here.
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium">Nobody is subscribed</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              An approved newsletter with no subscribers is not queued at all, and the approval
              says so rather than recording a send that reached nobody.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-rule">
            {[...active, ...gone].map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5"
              >
                <span className={`pill justify-center ${
                  r.status === 'active' ? 'bg-ok-bg text-ok' : 'bg-sunk text-ink-70'}`}>
                  {r.status === 'active' ? 'Active' : 'Unsubscribed'}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">{r.email}</span>
                  <span className="block truncate text-xs text-muted">
                    {r.name ? `${r.name} · ` : ''}
                    {r.source ?? 'source not recorded'}
                    {r.unsubscribed_at
                      ? ` · left ${new Date(r.unsubscribed_at).toLocaleDateString()}`
                      : ` · added ${new Date(r.created_at).toLocaleDateString()}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet h-8 px-2.5 py-0 text-xs"
                  disabled={busy}
                  onClick={() => askStatus(r, r.status === 'active' ? 'unsubscribed' : 'active')}
                >
                  {r.status === 'active' ? 'Unsubscribe' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Confirm spec={confirm} busy={busy} onCancel={() => setConfirm(null)} />
    </>
  );
}
