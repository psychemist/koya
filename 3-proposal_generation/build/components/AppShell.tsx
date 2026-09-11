import Link from "next/link";
import type { ReactNode } from "react";
import type { User } from "../lib/auth";
import { logoutAction } from "../app/login/actions";
import { AccountMenu } from "./AccountMenu";
import { MainNav } from "./MainNav";

/**
 * The application chrome.
 *
 * The role is displayed permanently in the header, not buried in a menu. In a
 * system whose central control is "a different person has to approve this",
 * who you are signed in as changes what the buttons do, and a reviewer
 * switching between two accounts needs to see at a glance which one they are
 * using.
 */

const NAV = [
  { href: "/", label: "Pipeline" },
  // The audit trail, by person. Everyone sees it; what each reader sees in it
  // is scoped by the same rule that decides which proposals they can open.
  { href: "/activity", label: "Activity" },
  // Admin only, both of them. Hidden rather than shown-and-refused: a link
  // that always bounces you is worse than no link.
  //
  // System moved behind the admin role along with Team. It reports what is
  // configured on this deployment, what every Claude call cost, and every
  // failed send with the client address attached — three things a salesperson
  // has no need of and one the firm would rather not hand to a stolen session.
  { href: "/system", label: "System", adminOnly: true },
  { href: "/team", label: "Team", adminOnly: true },
] as const;

export function AppShell({
  user,
  children,
  /** Rendered flush against the header, for the workspace's own toolbar. */
  subheader,
  /** Full-bleed pages (the workspace) manage their own scrolling. */
  bleed = false,
}: {
  user: User;
  children: ReactNode;
  subheader?: ReactNode;
  bleed?: boolean;
}) {
  /**
   * Bleed pages own the viewport exactly.
   *
   * The workspace used to be sized `100vh - 56px` inside a `min-h-screen`
   * column, which assumed the header was exactly 56px and that `vh` matched
   * the visible viewport. Neither holds: the header wraps on a narrow window,
   * and on mobile `vh` includes the retracting browser chrome. The result was
   * a strip of page ground below the three panes that scrolled into view and
   * dragged when overscrolled. `h-dvh` with the panes as flex children makes
   * the arithmetic the browser's problem, and there is nothing left to
   * scroll past.
   */
  /*
   * ...and only above `lg`.
   *
   * The viewport-height, overflow-hidden box is right for the three-column
   * workspace and wrong for the stacked one. Below 1024px the columns are on
   * top of each other, so pinning them inside one screen height gave a phone
   * two clipped scroll windows and no way to see a whole section of the
   * document. Above 1024px nothing changes.
   */
  return (
    <div
      className={`flex flex-col ${
        bleed ? "min-h-dvh lg:h-dvh lg:overflow-hidden" : "min-h-dvh"
      }`}
    >
      {/*
       * The header fits the viewport at every width, which it did not.
       *
       * It was a single non-wrapping flex row of fixed-width items with a
       * `gap-5` between them, and below roughly 1000px the total came to more
       * than the window. Nothing clipped visibly, so it looked fine; what
       * actually happened is that the row pushed the document wider than the
       * viewport and the last item in it went past the right edge. That last
       * item is the account menu, which is the only route to Sign out and to
       * the theme control, so on a phone the application had no way out of
       * itself.
       *
       * Three things fix it and all three are needed. The row may shrink
       * (`min-w-0` on the two flexible children, or a flex item refuses to go
       * below its content width). The two decorative pieces stand down first,
       * before anything functional does: the wordmark's second half and the
       * rule beside the account menu. And `overflow-x-clip` on the header is
       * the guarantee rather than the fix, so that a long name in some future
       * locale cannot reopen this by a different route.
       */}
      <header
        className={`app-header z-30 shrink-0 overflow-x-clip border-b border-[var(--border)] backdrop-blur-md ${
          bleed ? "" : "sticky top-0"
        }`}
      >
        <div className="mx-auto flex h-[58px] w-full max-w-[1400px] items-center gap-3 px-4 sm:gap-5 sm:px-5">
          <Link href="/" className="wordmark shrink-0 no-underline hover:no-underline">
            <span className="wordmark-koya">Koya</span>
            {/* Below 640px the product name goes and the mark carries it. The
                page title says which page you are on either way. */}
            <span className="wordmark-rule hidden sm:block" aria-hidden="true" />
            <span className="wordmark-name hidden sm:block">Proposal Studio</span>
          </Link>

          <div className="min-w-0 flex-1">
            <MainNav
              items={NAV.filter((item) => !("adminOnly" in item) || user.role === "admin")}
            />
          </div>

          <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-2.5">
            <Link
              href="/proposals/new"
              className="btn btn-primary btn-sm no-underline hover:no-underline"
            >
              <span aria-hidden="true" className="t-base leading-none">
                +
              </span>
              {/* The word carries the meaning on a wide screen; on a narrow
                  one the plus does, and the accessible name keeps both. */}
              <span className="hidden sm:inline">New proposal</span>
              <span className="sr-only sm:hidden">New proposal</span>
            </Link>
            <span className="header-divider hidden sm:block" aria-hidden="true" />
            <AccountMenu user={user} signOut={logoutAction} />
          </div>
        </div>
        {subheader}
      </header>

      {bleed ? (
        <div className="min-h-0 flex-1 lg:overflow-hidden">{children}</div>
      ) : (
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-7">{children}</main>
      )}
    </div>
  );
}

/** Page heading used by the non-workspace pages. */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {back ? (
          <Link href={back.href} className="t-sm text-[var(--muted)]">
            ← {back.label}
          </Link>
        ) : null}
        <h1 className="page-title mt-1">{title}</h1>
        {/*
          70ch was too tight: a two-sentence description broke onto a second
          line on a wide screen, which under a heading reads as a wrapping
          accident rather than a paragraph. The cap is still there, so a long
          description keeps a sane measure and a narrow window still wraps
          instead of overflowing.
        */}
        {description ? (
          <p className="hint mt-1.5 max-w-[108ch] t-base leading-relaxed text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
