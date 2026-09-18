'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Where you are, marked. The previous masthead gave both links the same
 * treatment, so the only way to tell which page you were on was to read it.
 *
 * `aria-current` carries that to a screen reader, because the underline does
 * not. The two are the same fact told twice, in the two ways it gets read.
 */
type NavLink = {
  href: string;
  label: string;
  /** True for '/', which would otherwise match every path by prefix. */
  exact?: boolean;
  /** The fuller wording, shown once there is room for it. */
  long?: string;
};

const LINKS: NavLink[] = [
  { href: '/', label: 'Requests', exact: true },
  { href: '/queue', label: 'Queue', long: 'Publishing Queue' },
];

export default function Nav({ showAdmin }: { showAdmin?: boolean }) {
  const path = usePathname() ?? '/';
  // Not rendered rather than rendered-and-disabled. A link that exists but
  // bounces you is a worse answer than one that does not exist, and the route
  // redirects a non-admin anyway.
  const links: NavLink[] = showAdmin ? [...LINKS, { href: '/admin', label: 'Admin' }] : LINKS;

  return (
    <nav aria-label="Main" className="flex shrink-0 items-center gap-0.5 text-sm">
      {links.map((l) => {
        const on = l.exact
          ? path === l.href || path.startsWith('/requests')
          : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={on ? 'page' : undefined}
            className={`relative rounded-md px-2.5 py-1.5 transition-colors ${
              on
                ? 'font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-[11px] ' +
                  'after:h-0.5 after:rounded-full after:bg-ink'
                : 'text-muted hover:bg-sunk hover:text-ink'
            }`}
          >
            {l.long ? (
              <>
                <span className="lg:hidden">{l.label}</span>
                <span className="hidden lg:inline">{l.long}</span>
              </>
            ) : (
              l.label
            )}
          </Link>
        );
      })}
    </nav>
  );
}
