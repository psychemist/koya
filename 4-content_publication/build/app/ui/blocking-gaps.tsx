'use client';
import { useState } from 'react';

/**
 * Everything blocking approval, grouped, in the space it deserves.
 *
 * It was a flat bulleted list of every open blocking flag, and a real run
 * produces fourteen. Each one is a full sentence, so the panel ran most of a
 * screen and pushed the drafts, the sources and the cost off the bottom of the
 * workspace. A person came to read the article and got a wall of findings.
 *
 * Grouping is by CHECK, not by asset, because that is the shape the findings
 * actually have: eleven of the fourteen are one gate firing eleven times, and
 * "eleven figures are not in any excerpt" is one problem with eleven
 * instances, not eleven problems. Collapsed, it is four lines. Open one and
 * you get its instances.
 *
 * The count stays visible while collapsed. A summary that hides how much is
 * behind it is how a reviewer talks themselves into expecting two.
 */
type Flag = {
  code: string;
  message: string;
  severity: string;
  asset_kind: string | null;
};

const GROUP_LABEL: Record<string, string> = {
  grounding: 'Figures with no source',
  channel: 'Channel rules',
  seo: 'Search and keywords',
  readability: 'Reading level',
  links: 'Links',
  verbatim: 'Copied from a source',
  house: 'House style',
  incomplete: 'Missing pieces',
  citation: 'Unfilled source gaps',
};

const KIND_LABEL: Record<string, string> = {
  article: 'Article', linkedin: 'LinkedIn', x: 'X', newsletter: 'Newsletter',
};

/** `grounding_unsupported_percent` and `grounding_unsupported_year` are one group. */
const groupOf = (code: string) => code.split('_')[0];

export default function BlockingGaps({
  flags, title,
}: { flags: Flag[]; title?: string }) {
  const [open, setOpen] = useState<string | null>(null);

  if (flags.length === 0) return null;

  const groups = new Map<string, Flag[]>();
  for (const f of flags) {
    const g = groupOf(f.code);
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  // Biggest first: the gate firing eleven times is the one to deal with.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <section className="sheet overflow-hidden border-blocking/30">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-blocking/20 bg-blocking-bg px-4 py-2.5">
        <h2 className="text-sm font-semibold text-blocking">
          {title ?? (flags.length === 1
            ? 'One thing blocks approval'
            : `${flags.length} things block approval`)}
        </h2>
        <p className="text-xs text-ink-70">
          {ordered.length === 1
            ? 'one check, expand it for the detail'
            : `across ${ordered.length} checks`}
        </p>
      </header>

      <ul className="divide-y divide-rule">
        {ordered.map(([group, items]) => {
          const isOpen = open === group;
          const kinds = [...new Set(items.map((i) => i.asset_kind).filter(Boolean))] as string[];
          return (
            <li key={group}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunk/50"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : group)}
              >
                <span
                  aria-hidden="true"
                  className={`shrink-0 text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}
                >
                  <svg width="8" height="10" viewBox="0 0 8 10">
                    <path d="M1 1 6 5 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium">
                  {GROUP_LABEL[group] ?? group.replace(/_/g, ' ')}
                </span>
                {kinds.length > 0 && (
                  <span className="hidden shrink-0 text-xs text-muted sm:inline">
                    {kinds.map((k) => KIND_LABEL[k] ?? k).join(', ')}
                  </span>
                )}
                <span className="pill shrink-0 bg-blocking-bg text-blocking tabular-nums">
                  {items.length}
                </span>
              </button>

              {isOpen && (
                <ul className="space-y-1.5 border-t border-rule bg-sunk/30 px-4 py-3 pl-9 text-sm">
                  {items.map((f, i) => (
                    <li key={i} className="flex gap-2.5 text-ink-70">
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blocking"
                      />
                      <span>
                        {f.message}
                        {f.asset_kind && (
                          <span className="text-muted">
                            {' '}({KIND_LABEL[f.asset_kind] ?? f.asset_kind})
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
