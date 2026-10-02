'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** A console tab that knows it is the current one. Conversations owns /console and every conversation page under it. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname() ?? '';
  const here = href === '/console'
    ? path === '/console' || path.startsWith('/console/conversations')
    : path === href || path.startsWith(`${href}/`);
  return <Link href={href} aria-current={here ? 'page' : undefined}>{children}</Link>;
}
