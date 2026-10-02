'use client';

import { useEffect, useState } from 'react';
import { usePersisted } from '../ui/use-persisted.ts';
import { ChevronIcon, ShieldIcon, UserIcon } from '../ui/icons.tsx';

/**
 * The support page frame: a white bar with the logo (top-left, unstyled, per
 * the brand asset), a flat deep-blue panel that says who you are and what we
 * can help with, and the workspace beside it. The panel folds to a narrow rail
 * so the conversation can take the width; the choice survives a refresh. On a
 * phone the panel sits above the chat, so it starts folded to one line there,
 * and that choice is kept apart from the desktop one.
 */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 899px)');
    const on = () => setNarrow(q.matches);
    on(); q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function SupportShell({ panel, children, rail, initials, railText, topRight }: {
  panel: React.ReactNode; children: React.ReactNode; rail: 'signed-out' | 'guest' | 'customer';
  initials?: string; railText?: string; topRight?: React.ReactNode;
}) {
  const narrow = useNarrow();
  const [wide, setWide] = usePersisted('rp_panel_collapsed', false);
  const [small, setSmall] = usePersisted('rp_panel_collapsed_narrow', true);
  const collapsed = narrow ? small : wide;
  const setCollapsed = narrow ? setSmall : setWide;
  const label = collapsed ? 'Show the side panel' : 'Hide the side panel';
  return (
    <div className="sp-page">
      <header className="sp-top">
        <img src="/relaypay-logo.png" alt="RelayPay" width={137} height={28} />
        <span className="sp-top-note">Customer support</span>
        {topRight && <div className="sp-top-right">{topRight}</div>}
      </header>
      <div className="sp-body" data-collapsed={collapsed}>
        <aside className="sp-panel" aria-label="About this support session">
          <button type="button" className="sp-fold" aria-expanded={!collapsed} aria-controls="sp-panel-full"
            aria-label={label} title={label} onClick={() => setCollapsed(!collapsed)}>
            <ChevronIcon direction={collapsed ? 'right' : 'left'} />
          </button>
          <div className="sp-rail" aria-hidden={!collapsed}>
            {rail === 'customer' && <span className="sp-rail-avatar" title="Signed in">{initials}<i /></span>}
            {rail === 'guest' && <span className="sp-rail-avatar" data-guest="true" title="Guest"><UserIcon size={18} /></span>}
            {railText && <span className="sp-rail-text">{railText}</span>}
            <span className="sp-rail-grow" />
            <span className="sp-rail-safe" title="We never ask for card numbers, passwords or one-time codes."><ShieldIcon size={18} /></span>
          </div>
          <div className="sp-panel-full" id="sp-panel-full" hidden={collapsed}>{panel}</div>
        </aside>
        <main className="sp-main">{children}</main>
      </div>
    </div>
  );
}
