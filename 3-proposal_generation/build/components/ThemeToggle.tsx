"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isThemeChoice,
  type ThemeChoice,
} from "../lib/theme";

/**
 * The theme control: System · Light · Dark, defaulting to System.
 *
 * Rendered as a segmented radiogroup rather than a cycling single button, so
 * all three states are visible at once and the current one is obvious. A
 * cycling button forces the user to click twice and guess where they will land.
 *
 * The label is an icon plus a word. An icon alone is a guess — a half-moon
 * could mean "dark mode is on" or "click for dark mode" — and this app's whole
 * design rule is that nothing is carried by one signal alone.
 */

const OPTIONS: { value: ThemeChoice; label: string; glyph: string; hint: string }[] = [
  { value: "system", label: "System", glyph: "◐", hint: "Follow my device setting" },
  { value: "light", label: "Light", glyph: "☀", hint: "Always light" },
  { value: "dark", label: "Dark", glyph: "☾", hint: "Always dark" },
];

function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    // Removing the attribute hands control back to the CSS media query, so the
    // OS stays authoritative with no JavaScript in the loop.
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  /**
   * Starts as null, not as the default.
   *
   * The server cannot know the stored preference, so rendering a highlighted
   * "System" and then correcting it after hydration would flash the wrong
   * selection. Null means "not yet known" and the buttons render unselected
   * for the one frame before the effect runs.
   */
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Site data blocked. Fall through to the default; the page still works.
    }
    setChoice(isThemeChoice(stored) ? stored : DEFAULT_THEME);
  }, []);

  /**
   * Keeps `color-scheme` honest while following the system.
   *
   * The CSS media query already re-themes the page when the OS flips, so this
   * listener is not what changes the colours. It exists so that other tabs and
   * a mid-session OS change land on a consistent attribute state, and so the
   * selected pill stays correct if the user switches at the OS level while
   * this page is open.
   */
  useEffect(() => {
    if (choice !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyChoice("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  function select(next: ThemeChoice): void {
    setChoice(next);
    applyChoice(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The choice still applies for this page; it just will not persist.
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="seg"
      title="Colour theme. System follows whatever your device is set to."
    >
      {OPTIONS.map((option) => {
        const selected = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${option.label} theme. ${option.hint}`}
            onClick={() => select(option.value)}
            className={selected ? "is-selected" : undefined}
          >
            <span aria-hidden="true" className="seg-glyph">
              {option.glyph}
            </span>
            {compact ? null : <span className="seg-label">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
