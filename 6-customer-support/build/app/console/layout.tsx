import Link from 'next/link';
import { headers } from 'next/headers';
import { requireConsoleUser } from '../../lib/console-session.ts';
import { roleLabel } from '../../lib/auth.ts';
import { SignOut } from '../ui/sign-out.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'RelayPay support console' };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireConsoleUser((await headers()).get('x-rp-path') ?? '/console');
  return (
    <div className="rp-console">
      <header className="rp-console-bar">
        <img src="/relaypay-logo.png" alt="RelayPay" width={117} height={24} />
        <nav aria-label="Console">
          <Link href="/console">Conversations</Link>
          <Link href="/console/tickets">Tickets</Link>
          <Link href="/console/escalations">Escalations</Link>
          <Link href="/console/evaluations">Evaluations</Link>
        </nav>
        <span className="rp-who-am-i">{user.name}, {roleLabel(user.role)}</span>
        <SignOut />
      </header>
      <main className="rp-console-main">{children}</main>
    </div>
  );
}
