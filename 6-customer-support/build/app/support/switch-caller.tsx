'use client';

import { useRouter } from 'next/navigation';
import { ConfirmButton } from '../ui/confirm.tsx';

/** Sign out, or leave guest mode to sign in. Both end the current chat, so both say so first. */
export function SwitchCaller({ kind }: { kind: 'customer' | 'guest' }) {
  const router = useRouter();
  async function leave(): Promise<string | null> {
    const res = await fetch('/api/support/session', { method: 'DELETE' }).catch(() => null);
    if (!res || (!res.ok && res.status !== 204)) return 'Nothing changed, because the server did not respond. Try again.';
    try { window.sessionStorage.removeItem('rp_chat_draft'); } catch { /* storage unavailable */ }
    router.refresh();
    return null;
  }
  return kind === 'customer'
    ? <ConfirmButton label="Sign out" className="rp-btn rp-btn-quiet rp-btn-small" title="Sign out?"
        body="This ends your chat. Any ticket or escalation reference you were given stays valid."
        confirmLabel="Sign out" cancelLabel="Stay signed in" onConfirm={leave} />
    : <ConfirmButton label="Sign in" className="rp-btn rp-btn-quiet rp-btn-small" title="Sign in to your account?"
        body="This ends your guest chat and takes you to sign in. Any reference you were given stays valid."
        confirmLabel="Go to sign in" cancelLabel="Stay as a guest" onConfirm={leave} />;
}
