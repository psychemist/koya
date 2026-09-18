'use client';
import { useEffect, useState } from 'react';

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, because "follow the system" is the one most
 * people actually want and a two-way switch cannot express it: once you have
 * clicked either side you are pinned there, and your laptop going dark at
 * sunset stops moving this app with it.
 *
 * The contract with the CSS is one attribute on the root element:
 *
 *   data-theme="light"   an explicit choice, beats the media query
 *   data-theme="dark"    an explicit choice, beats the media query
 *   (absent)             no choice stored, the media query decides
 *
 * The stored value is read by the inline script in the layout BEFORE first
 * paint. Doing it here alone would render the light palette and then correct
 * itself, which is the white flash every dark-mode implementation ships with
 * at least once.
 */
export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'koya:theme';

/** One definition, because the inline script below has to agree with it. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: 'light', label: 'Light', title: 'Always light' },
  { value: 'system', label: 'Auto', title: 'Follow the system setting' },
  { value: 'dark', label: 'Dark', title: 'Always dark' },
];

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY) as Theme | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored);
    } catch {
      // Storage blocked. The system setting is a perfectly good answer.
    }
    setReady(true);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice still applies to this page, it just will not be remembered.
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-full bg-sunk p-0.5"
    >
      {OPTIONS.map((o) => {
        // Nothing is marked selected until the stored value has been read.
        // Marking "Auto" first would flash the wrong control on a machine
        // whose owner has pinned this app to dark.
        const on = ready && theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => choose(o.value)}
            className={`rounded-full px-2 py-1 text-xs font-medium transition-colors ${
              on ? 'bg-sheet text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Runs before first paint, so the page is never painted in the wrong palette
 * and then corrected.
 *
 * Deliberately tiny and deliberately wrapped: this executes before anything
 * else on the page, and an exception here would take the whole document with
 * it. A browser with storage blocked falls through to the media query, which
 * is the right answer anyway.
 */
export const THEME_SCRIPT = `
(function(){try{
  var t = localStorage.getItem('${THEME_KEY}');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
}catch(e){}})();
`.trim();
