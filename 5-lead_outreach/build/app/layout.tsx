import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Koya Lead Desk',
  description:
    'Research and qualify companies, then review the drafts before anyone sends anything.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
