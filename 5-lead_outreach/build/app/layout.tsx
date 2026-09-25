import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Two families, doing two different jobs.
 *
 * Archivo is a grotesque drawn for signage and dense interfaces, which is what
 * this is. JetBrains Mono is used for one thing only: text retrieved from a
 * third-party website. That distinction is load bearing, because a reviewer
 * must never mistake a quoted page for something Koya wrote.
 */
const sans = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Koya Talent Lead Desk',
  description:
    'Research and qualify companies, then review the drafts before anyone sends anything.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
