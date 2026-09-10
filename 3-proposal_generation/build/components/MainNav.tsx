"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation, with the current section marked.
 *
 * The header had no active state at all, so every page looked like every
 * other page and the nav read as three unrelated links. Knowing where you
 * are is the first job navigation has.
 */
export function MainNav({ items }: { items: readonly { href: string; label: string }[] }) {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="nav-main" aria-label="Main">
      {items.map((item) => {
        // "/" matches only itself; everything else matches its subtree, so a
        // proposal page still highlights Pipeline.
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`nav-link no-underline hover:no-underline ${active ? "is-active" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
