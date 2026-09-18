import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono, Newsreader } from 'next/font/google';
import './globals.css';
import Link from 'next/link';
import { currentUser, roleLabel } from '@/lib/auth';
import { config } from '@/lib/config';
import ThemeToggle, { THEME_SCRIPT } from './ui/theme-toggle';
import SignOut from './ui/sign-out';
import Nav from './ui/nav';
import RoleSwitcher from './ui/role-switcher';

/**
 * Two families with clearly different jobs, plus a mono used for two things
 * only. Plex Sans runs the tool. Newsreader sets the proof, because the draft
 * is the one thing on screen a person has to read rather than scan. Plex Mono
 * appears on evidence hashes and correlation IDs, which people compare
 * character by character, and nowhere else.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});
const serif = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-newsreader',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Koya Content Desk',
  description: 'Research, draft, check and publish, with a person in the loop.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);

  // An admin, or an identity an admin switched into. Both keep the switcher,
  // which is what makes the switch reversible without signing out.
  const canSwitch = config.demoRoleSwitch
    && Boolean(user && (user.role === 'admin' || user.switchedFromId));

  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${serif.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the stored theme before first paint. Without it the page
            renders light and then corrects itself, which is the white flash
            every dark mode ships with at least once. suppressHydrationWarning
            on <html> is required, because this script legitimately changes an
            attribute the server did not render. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        {/* A keyboard user should not have to tab through the masthead on
            every page to reach the thing they came for. */}
        <a
          href="#main"
          // `text-on-ink` rather than `text-white`, for the same reason the
          // buttons use it: the ink inverts between themes, so a fixed white
          // label disappears into a near-white background in dark mode.
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                     focus:rounded focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:text-on-ink"
        >
          Skip to content
        </a>

        {/*
          THE MASTHEAD IS ONLY FOR PEOPLE WHO ARE SIGNED IN.

          Signed out there is exactly one thing to do, and a nav bar offering
          two links that both bounce you back is furniture. Dropping it also
          frees the sign-in screen to use the full window, which is what lets
          it be a page rather than a form box floating in the middle of one.
        */}
        {user && (
          <header className="sticky top-0 z-30 border-b border-rule bg-sheet/85 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-336 items-center gap-3 px-5 sm:gap-6">
              <Link
                href="/"
                className="flex shrink-0 items-center gap-2.5 rounded"
                aria-label="Koya Content Desk, home"
              >
                {/* A mark, so the masthead has an anchor at the left edge that
                    is not four words of text. Two overlapping sheets: the
                    draft and the proof of it. */}
                <span
                  aria-hidden="true"
                  className="grid size-6 shrink-0 place-items-center rounded-md bg-ink text-[11px]
                             font-semibold text-on-ink"
                >
                  K
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[15px] font-semibold tracking-[-0.02em]">Koya</span>
                  {/* The suffix is the first thing to go on a narrow screen.
                      The wordmark alone still says where you are; a masthead
                      that wraps onto two lines does not. */}
                  <span className="hidden text-[15px] text-muted sm:inline">Content Desk</span>
                </span>
              </Link>

              <span aria-hidden="true" className="hidden h-5 w-px bg-rule sm:block" />

              <Nav showAdmin={user.role === 'admin'} />

              <div className="ml-auto flex min-w-0 items-center gap-2">
                <ThemeToggle />

                {canSwitch && <RoleSwitcher current={user.role} />}

                {/* Name and role read as one object, because they answer one
                    question: who the desk thinks you are right now. The role
                    is stated rather than left to be inferred from which
                    buttons happen to be disabled. */}
                <div className="flex items-center gap-2 rounded-full border border-rule bg-sunk/60 py-1 pl-2.5 pr-1">
                  <span className="hidden max-w-[12rem] truncate text-xs font-medium lg:inline">
                    {user.name}
                  </span>
                  <span className="pill bg-sheet text-ink-70">{roleLabel(user.role)}</span>
                  <SignOut />
                </div>
              </div>
            </div>

            {/*
              An admin wearing somebody else's identity has to be able to see
              that at a glance. Without this the demo's most confusing moment
              is real: you approve as Tomi, forget you did, and cannot work out
              why the next request will not let you.
            */}
            {user.switchedFromId && (
              <div className="border-t border-rule bg-advisory-bg">
                <p className="mx-auto max-w-336 px-5 py-1.5 text-xs text-advisory">
                  You are signed in as {user.name} ({roleLabel(user.role)}) through the demo
                  switcher. Anything you decide is recorded against {user.name}, not against
                  the admin account.
                </p>
              </div>
            )}
          </header>
        )}

        {user ? (
          <main id="main" className="mx-auto max-w-336 px-5 py-8">{children}</main>
        ) : (
          <main id="main">{children}</main>
        )}

        {user && (
          <footer className="mx-auto max-w-336 px-5 pb-10 pt-4 text-xs text-muted">
            Nothing is published until a person approves it, and any edit after approval voids
            that approval.
          </footer>
        )}
      </body>
    </html>
  );
}
