/**
 * Theme preference: System (the default), Light, or Dark.
 *
 * Three states rather than a two-way switch, because "follow my machine" is a
 * real preference and not the absence of one. A binary toggle silently
 * commits the user to whichever mode they first clicked, and they can never
 * get back to following their OS — which is what most people actually want,
 * and what a laptop that flips to dark at sunset depends on.
 */

export const THEME_STORAGE_KEY = "koya-theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const DEFAULT_THEME: ThemeChoice = "system";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/**
 * The script that runs before first paint.
 *
 * This exists solely to prevent the flash of the wrong theme. Without it, the
 * server sends markup with no `data-theme`, the browser paints light, and then
 * React hydrates and switches to dark — a white flash on every navigation for
 * every dark-mode user. Applying the attribute synchronously, before the
 * document is painted, is the only way to avoid it.
 *
 * Notes on why it is written the way it is:
 *
 *   - It sets the attribute ONLY for an explicit light/dark choice. "system"
 *     deliberately leaves the attribute absent, so the CSS media query does
 *     the work and the OS stays in charge with no JavaScript involved.
 *   - Everything is inside try/catch. `localStorage` throws outright in some
 *     configurations (Safari private browsing, blocked site data), and a theme
 *     preference is not worth taking the page down for. The catch falls
 *     through to the system default.
 *   - It is minified by hand rather than by a build step, because it is
 *     inlined into the document and every byte is in the critical path.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;
