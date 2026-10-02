import { headers } from 'next/headers';
import { requireConsoleUser } from '../../lib/console-session.ts';
import { canSeeEvaluations, roleLabel } from '../../lib/auth.ts';
import { ConsoleShell } from './console-shell.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'RelayPay Support Console' };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireConsoleUser((await headers()).get('x-rp-path') ?? '/console');
  return (
    <ConsoleShell name={user.name} role={roleLabel(user.role)} evaluations={canSeeEvaluations(user)}>
      {children}
    </ConsoleShell>
  );
}
