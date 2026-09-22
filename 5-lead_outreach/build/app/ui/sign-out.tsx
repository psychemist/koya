'use client';

export function SignOut() {
  return (
    <button
      className="quiet"
      onClick={async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
      }}
    >
      Sign out
    </button>
  );
}
