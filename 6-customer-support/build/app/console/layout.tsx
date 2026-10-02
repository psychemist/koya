import { headers } from 'next/headers';
import { requireConsoleUser } from '../../lib/console-session.ts';
import { canSeeEvaluations, roleLabel } from '../../lib/auth.ts';
import { SignOut } from '../ui/sign-out.tsx';
import { NavLink } from '../ui/nav-link.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'RelayPay Support Console' };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireConsoleUser((await headers()).get('x-rp-path') ?? '/console');
  return (
    <div className="rp-console">
      <header className="rp-console-bar">
        <div className="rp-console-bar-in">
          <img src="/relaypay-logo.png" alt="RelayPay" width={117} height={24} />
          <nav aria-label="Console">
            <NavLink href="/console">Conversations</NavLink>
            <NavLink href="/console/tickets">Tickets</NavLink>
            <NavLink href="/console/escalations">Escalations</NavLink>
            {canSeeEvaluations(user) && <NavLink href="/console/evaluations">Evaluations</NavLink>}
          </nav>
          <div className="rp-who-am-i"><span>{user.name}, {roleLabel(user.role)}</span><SignOut /></div>
        </div>
      </header>
      <main className="rp-console-main">{children}</main>
    </div>
  );
}
