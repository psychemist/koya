import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--rp-font' });

export const metadata: Metadata = {
  title: 'RelayPay Support',
  description: 'Talk to RelayPay support by voice or chat.',
  robots: { index: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f3f5f8' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
