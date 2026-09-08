import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import "./globals.css";

/**
 * Fonts are loaded through next/font, which downloads and self-hosts them at
 * build time. Two reasons that matters here: the Content-Security-Policy in
 * next.config.ts does not need to allow an external font host, and a proposal
 * never renders in a fallback face because fonts.gstatic.com was slow.
 *
 * Inter for the chrome, Source Serif for the document. The pairing is the
 * design's central idea — see the comment at the top of globals.css.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
  // 650 is used for emphasis inside the document; the axis has to include it.
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: {
    default: "Koya Proposal Studio",
    template: "%s · Koya Proposal Studio",
  },
  description:
    "Turn discovery-call notes into a client-ready proposal: Claude drafts it, a salesperson revises it, an approver signs it off.",
  robots: {
    // An internal sales tool with client names in it has no business in a
    // search index, and the client-facing pages are unlisted by design.
    index: false,
    follow: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e12" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` is required and specific: the inline script
     * below sets `data-theme` on this element before React hydrates, so the
     * server markup and the live DOM genuinely differ by that one attribute.
     * The warning is correct in general and wrong here, and it is suppressed
     * on this element only.
     */
    <html
      lang="en-GB"
      className={`${inter.variable} ${sourceSerif.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/*
         * Runs before first paint, which is the entire point. Without it a
         * dark-mode user gets a white flash on every page load: the server
         * has no way to know their stored preference, so the first paint is
         * light and hydration corrects it a moment later.
         *
         * It reads one localStorage key and sets one attribute. Nothing else
         * is allowed in the critical path.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
