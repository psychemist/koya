'use client';

import { usePersisted } from '../ui/use-persisted.ts';
import { NavLink } from '../ui/nav-link.tsx';
import { BookIcon, ChartIcon, ChatIcon, ChecklistIcon, ChevronIcon, FlagIcon, SignOutIcon, TicketIcon } from '../ui/icons.tsx';

/**
 * The console frame, built like the support page: the logo on a white bar, a flat deep-blue sidebar with the
 * sections and who is signed in, and the work beside it. The sidebar folds to icons; the choice survives a refresh.
 */
export function ConsoleShell({ name, role, evaluations, children }: {
  name: string; role: string; evaluations: boolean; children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = usePersisted('rp_console_collapsed', false);
  const label = collapsed ? 'Show the sidebar' : 'Hide the sidebar';
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  async function signOut() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/sign-in'; }
  const items = [
    { href: '/console', label: 'Conversations', icon: <ChatIcon size={19} /> },
    { href: '/console/tickets', label: 'Tickets', icon: <TicketIcon size={19} /> },
    { href: '/console/escalations', label: 'Escalations', icon: <FlagIcon size={19} /> },
    ...(evaluations ? [
      { href: '/console/evaluations', label: 'Evaluations', icon: <ChecklistIcon size={19} /> },
      { href: '/console/analytics', label: 'Analytics', icon: <ChartIcon size={19} /> },
      { href: '/console/knowledge', label: 'Knowledge base', icon: <BookIcon size={19} /> },
    ] : []),
  ];
  return (
    <div className="sp-page">
      <header className="sp-top">
        <img src="/relaypay-logo.png" alt="RelayPay" width={137} height={28} />
        <span className="sp-top-note">Support console</span>
      </header>
      <div className="cs-body" data-collapsed={collapsed}>
        <aside className="cs-side">
          <button type="button" className="sp-fold cs-fold" aria-expanded={!collapsed} aria-label={label} title={label}
            onClick={() => setCollapsed(!collapsed)}>
            <ChevronIcon direction={collapsed ? 'right' : 'left'} />
          </button>
          <nav className="cs-nav" aria-label="Console">
            {items.map((i) => (
              <NavLink key={i.href} href={i.href} title={collapsed ? i.label : undefined}>
                {i.icon}<span className="cs-label">{i.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="cs-grow" />
          <div className="cs-user">
            <span className="cs-avatar" aria-hidden="true">{initials}</span>
            <span className="cs-label cs-user-text"><b>{name}</b><span>{role}</span></span>
            <button type="button" className="cs-signout" onClick={signOut} aria-label="Sign out" title="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </aside>
        <main className="cs-main">{children}</main>
      </div>
    </div>
  );
}
