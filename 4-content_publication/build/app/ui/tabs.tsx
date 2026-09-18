'use client';
import { useState } from 'react';

/**
 * Three views of one request, so the page is a page rather than a scroll.
 *
 * The workspace was one column holding a failure banner, the sources, the
 * angle, fourteen blocking findings and four full drafts, in that order. The
 * drafts are what somebody came for and they were four screens down. Nothing
 * on it was wrong; there was simply more of it than a screen.
 *
 * Tabs rather than collapsible sections because these three are alternatives,
 * not a sequence: you are reading the drafts, or checking what was read, or
 * finding out who was told. You are never doing two at once.
 *
 * All three panels are RENDERED, and the inactive ones are hidden with the
 * `hidden` attribute rather than unmounted. Browser find-in-page still reaches
 * them, and a tab switch does not throw away scroll position or re-run a
 * server render.
 */
export default function Tabs({
  tabs, initial,
}: {
  tabs: { key: string; label: string; count?: number; badge?: 'blocking' | 'advisory';
          panel: React.ReactNode }[];
  initial?: string;
}) {
  const [active, setActive] = useState(initial ?? tabs[0]?.key);

  return (
    <div>
      <div role="tablist" aria-label="Request details" className="flex gap-1 border-b border-rule">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`tab-${t.key}`}
              aria-selected={on}
              aria-controls={`panel-${t.key}`}
              onClick={() => setActive(t.key)}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${
                on
                  ? 'border-ink font-semibold text-ink'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {t.count != null && (
                <span className={`pill tabular-nums ${
                  t.badge === 'blocking' ? 'bg-blocking-bg text-blocking'
                  : t.badge === 'advisory' ? 'bg-advisory-bg text-advisory'
                  : 'bg-sunk text-ink-70'}`}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`panel-${t.key}`}
          aria-labelledby={`tab-${t.key}`}
          hidden={t.key !== active}
          className="pt-5"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}
