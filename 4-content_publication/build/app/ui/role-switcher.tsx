'use client';
import { useState } from 'react';

/**
 * Switches the session into another seeded account, for the demo.
 *
 * Shown only to a session an admin is behind. It says "Viewing as" rather than
 * "Role" on purpose: you are not changing what this person may do, you are
 * becoming a different person, and every decision that follows is recorded
 * against THAT person. Calling it a role switch would misdescribe the audit
 * trail it produces.
 */
const ROLES = [
  { value: 'manager', label: 'Manager', who: 'Ada Okafor, raises requests' },
  { value: 'editor', label: 'Editor', who: 'Tomi Balogun, approves them' },
  { value: 'admin', label: 'Admin', who: 'back to your own account' },
] as const;

export default function RoleSwitcher({ current }: { current: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function switchTo(role: string) {
    if (role === current) { setOpen(false); return; }
    setBusy(role);
    setFailed(null);
    try {
      const res = await fetch('/api/demo/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setFailed(j?.error?.message ?? 'The switch did not go through.');
        setBusy(null);
        return;
      }
      // A full load, not a router push. Every page here renders server-side
      // from the session cookie, so a client navigation would leave the
      // previous identity's name and permissions on screen.
      window.location.href = '/';
    } catch {
      setFailed('The switch did not reach the server. You are still signed in as before.');
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn btn-quiet h-8 gap-1.5 px-2.5 py-0 text-xs"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        disabled={Boolean(busy)}
      >
        <span className="text-muted">Viewing as</span>
        <span className="font-semibold">
          {ROLES.find((r) => r.value === current)?.label ?? current}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="opacity-60">
          <path d="M1 3.5 5 7.5 9 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <>
          {/* Clicking anywhere else closes it, including on the page behind. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="sheet absolute right-0 z-50 mt-1.5 w-64 overflow-hidden p-1 shadow-lg"
          >
            <p className="px-2.5 py-2 text-xs text-muted">
              Signs you in as that person, so the separation of duties gate stays real.
            </p>
            {ROLES.map((r) => (
              <button
                key={r.value}
                role="menuitem"
                type="button"
                onClick={() => switchTo(r.value)}
                disabled={Boolean(busy)}
                className={`flex w-full items-start gap-2 rounded px-2.5 py-2 text-left text-sm
                            hover:bg-sunk disabled:opacity-50 ${
                              r.value === current ? 'bg-sunk' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                    r.value === current ? 'bg-ok' : 'bg-rule-strong'}`}
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {busy === r.value ? 'Switching' : r.label}
                  </span>
                  <span className="block text-xs text-muted">{r.who}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {failed && (
        <p role="alert" className="absolute right-0 top-full mt-1 w-64 text-xs text-blocking">
          {failed}
        </p>
      )}
    </div>
  );
}
