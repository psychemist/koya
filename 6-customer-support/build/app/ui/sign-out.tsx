'use client';

export function SignOut() {
  return (
    <button type="button" className="rp-btn rp-btn-quiet rp-btn-small"
      onClick={async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/sign-in'; }}>
      Sign out
    </button>
  );
}
