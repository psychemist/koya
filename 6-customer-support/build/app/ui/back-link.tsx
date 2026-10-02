'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronIcon } from './icons.tsx';

/**
 * Back to the list a record was opened from. When the console itself brought you here, it goes back in history,
 * so the filters you had on the list are still set; opened from a Discord or email link, it goes to the list.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <Link href={href} className="rp-back" onClick={(e) => {
      try {
        const from = document.referrer ? new URL(document.referrer) : null;
        if (from && from.origin === window.location.origin && from.pathname.startsWith('/console') && window.history.length > 1) {
          e.preventDefault(); router.back();
        }
      } catch { /* fall through to the link */ }
    }}>
      <ChevronIcon size={16} direction="left" />{label}
    </Link>
  );
}
