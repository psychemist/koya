'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type LeadGroup = { key: string; label: string; count: number; panel: ReactNode };

/**
 * The lead list, grouped by the agent's verdict.
 *
 * A reviewer works one verdict at a time: accept the qualified, argue with the
 * ones held for review, and only audit the rejections when the count looks
 * wrong. A single column of thirty made them scroll past two groups to reach
 * the third.
 *
 * Every panel stays mounted and is hidden rather than unmounted, so a
 * half-edited draft or an open note survives a trip to another tab.
 */
export function LeadTabs({ groups }: { groups: LeadGroup[] }) {
  // Opening on an empty group reads as "the run found nothing", so the first
  // group that actually has leads wins the first look.
  const [selected, setSelected] = useState(
    () => (groups.find((g) => g.count > 0) ?? groups[0]).key,
  );
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});

  const active = groups.some((g) => g.key === selected) ? selected : groups[0].key;

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const here = groups.findIndex((g) => g.key === active);
    const to =
      event.key === 'ArrowRight' ? (here + 1) % groups.length
      : event.key === 'ArrowLeft' ? (here - 1 + groups.length) % groups.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? groups.length - 1
      : -1;
    if (to < 0) return;
    event.preventDefault();
    setSelected(groups[to].key);
    tabs.current[groups[to].key]?.focus();
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Leads by verdict" onKeyDown={move}>
        {groups.map((g) => {
          const current = g.key === active;
          return (
            <button
              key={g.key}
              ref={(el) => { tabs.current[g.key] = el; }}
              type="button"
              role="tab"
              id={`tab-${g.key}`}
              aria-controls={`panel-${g.key}`}
              aria-selected={current}
              tabIndex={current ? 0 : -1}
              className={current ? undefined : 'quiet'}
              onClick={() => setSelected(g.key)}
            >
              {g.label}<span className="count">{g.count}</span>
            </button>
          );
        })}
      </div>

      {groups.map((g) => (
        <div
          key={g.key}
          role="tabpanel"
          id={`panel-${g.key}`}
          aria-labelledby={`tab-${g.key}`}
          tabIndex={0}
          hidden={g.key !== active}
        >
          {g.panel}
        </div>
      ))}
    </>
  );
}
