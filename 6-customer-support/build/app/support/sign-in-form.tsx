'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePersisted } from '../ui/use-persisted.ts';

/**
 * Customer or guest. A customer proves who they are with two details that must
 * belong to one account, the same rule the agent applies on a call, so the
 * agent never has to ask again. A guest goes straight to knowledge-base help.
 */
export function SignInForm() {
  const router = useRouter();
  const [tab, setTab] = usePersisted<'customer' | 'guest'>('rp_signin_tab', 'customer', 'session');
  const [form, setForm, clearForm] = usePersisted('rp_signin', { email: '', customer_id: '' }, 'session');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(body: object) {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/support/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? 'That did not work. Try again.'); return; }
      clearForm();
      router.refresh();
    } catch { setError('The server did not respond. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="sp-signin">
      <div className="sp-tabs" role="group" aria-label="How you want to continue" data-tab={tab}>
        <button type="button" aria-pressed={tab === 'customer'} onClick={() => { setTab('customer'); setError(''); }}>I am a customer</button>
        <button type="button" aria-pressed={tab === 'guest'} onClick={() => { setTab('guest'); setError(''); }}>Continue as a guest</button>
      </div>

      {tab === 'customer' ? (
        <form className="sp-form" onSubmit={(e) => { e.preventDefault(); void start({ mode: 'customer', ...form }); }}>
          <h2>Sign in to your account</h2>
          <p className="sp-form-lede">Use the email on your RelayPay account and your customer ID. Support can then check your payments without asking who you are.</p>
          {error && <p className="sp-error" role="alert">{error}</p>}
          <label htmlFor="sp-email">Account Email</label>
          <input id="sp-email" type="email" autoComplete="email" required value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <label htmlFor="sp-cid">Customer ID</label>
          <input id="sp-cid" autoComplete="off" required value={form.customer_id} placeholder="For example CUS-1234" aria-describedby="sp-cid-help"
            onChange={(e) => setForm({ ...form, customer_id: e.target.value })} />
          <small id="sp-cid-help">It is on your invoices and in Settings, and starts with CUS.</small>
          <button type="submit" className="rp-btn" disabled={busy}>{busy ? 'Checking your account' : 'Continue to support'}</button>
        </form>
      ) : (
        <div className="sp-form">
          <h2>Continue as a guest</h2>
          <p className="sp-form-lede">Ask general questions about fees, payment timelines and our policies. We will not look up any account, transaction or payout, so do not share account details here.</p>
          {error && <p className="sp-error" role="alert">{error}</p>}
          <button type="button" className="rp-btn" disabled={busy} onClick={() => void start({ mode: 'guest' })}>
            {busy ? 'Starting' : 'Continue as a guest'}
          </button>
          <p className="sp-form-note">Need help with a payment? <button type="button" className="rp-link-btn" onClick={() => setTab('customer')}>Sign in instead</button></p>
        </div>
      )}
    </div>
  );
}
