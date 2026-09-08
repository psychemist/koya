import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THEME,
  THEME_CHOICES,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  isThemeChoice,
} from "../../lib/theme";

/**
 * Theme and palette tests.
 *
 * The contrast checks parse the ACTUAL stylesheet rather than a copy of the
 * values. That matters: a test holding its own duplicate of the palette
 * passes happily while the real one drifts, which is precisely the failure it
 * was meant to catch. Editing a colour in globals.css re-runs these numbers.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "globals.css"),
  "utf8",
);

/** Reads a `--token: #value;` declaration out of the stylesheet. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(CSS);
  assert.ok(match, `--${name} is not defined as a hex colour in globals.css`);
  return match![1]!;
}

// ---------------------------------------------------------------- contrast

function channels(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every pair that carries meaning, with its WCAG minimum.
 *
 * 4.5:1 for anything a person reads as text. 3:1 for muted metadata, which is
 * large-text/incidental and deliberately recessive — pushing it to 4.5 would
 * make it as loud as the content it sits beside.
 */
const PAIRS: [string, string, string, number][] = [
  ["body text on page", "ink", "page", 4.5],
  ["body text on surface", "ink", "surface", 4.5],
  ["secondary text on surface", "ink-2", "surface", 4.5],
  ["muted metadata on surface", "muted", "surface", 3],
  ["muted metadata on page", "muted", "page", 3],
  ["document text on paper", "paper-ink", "paper", 4.5],
  ["document muted on paper", "paper-muted", "paper", 4.5],
  ["accent link on surface", "accent", "surface", 4.5],
  ["accent on its own tint", "accent", "accent-soft", 4.5],
  ["good on its own tint", "good", "good-soft", 4.5],
  ["attention on its own tint", "attention", "attention-soft", 4.5],
  ["bad on its own tint", "bad", "bad-soft", 4.5],
];

test("light palette meets its contrast minimums", () => {
  for (const [name, fg, bg, min] of PAIRS) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= min, `${name}: ${ratio.toFixed(2)}:1 is below ${min}:1`);
  }
});

test("dark palette meets its contrast minimums", () => {
  for (const [name, fg, bg, min] of PAIRS) {
    const ratio = contrast(token(`d-${fg}`), token(`d-${bg}`));
    assert.ok(ratio >= min, `dark ${name}: ${ratio.toFixed(2)}:1 is below ${min}:1`);
  }
});

test("the dark palette is genuinely darker than the light one", () => {
  // Guards against a copy-paste that leaves a light value in the dark set.
  assert.ok(
    luminance(token("d-page")) < luminance(token("page")),
    "dark page is not darker than light page",
  );
  assert.ok(
    luminance(token("d-ink")) > luminance(token("d-page")),
    "dark ink must be lighter than the dark ground",
  );
});

test("paper is warmer than chrome in both modes", () => {
  // The design's central distinction: the application recedes, the document
  // does not. If paper and chrome converge in temperature, a proposal stops
  // reading as paper — which is what went wrong in the first light palette.
  const warmth = (hex: string): number => {
    const [r, , b] = channels(hex);
    return r - b; // red minus blue: positive is warm
  };
  assert.ok(
    warmth(token("paper")) > warmth(token("surface")),
    "light paper must be warmer than light surface",
  );
  assert.ok(
    warmth(token("d-paper")) > warmth(token("d-surface")),
    "dark paper must be warmer than dark surface",
  );
});

test("every live token has a dark counterpart", () => {
  // Any token the dark blocks remap must exist in the --d-* set, or dark mode
  // silently falls back to the light value.
  const remapped = [...CSS.matchAll(/--([a-z0-9-]+):\s*var\(--d-([a-z0-9-]+)\)/g)];
  assert.ok(remapped.length >= 20, `expected the dark remapping block, found ${remapped.length}`);
  for (const match of remapped) {
    const darkName = match[2]!;
    assert.ok(
      new RegExp(`--d-${darkName}:`).test(CSS),
      `--d-${darkName} is referenced but never defined`,
    );
  }
});

test("the two dark activation blocks remap the same tokens", () => {
  // One block is the system-preference path and one is the explicit choice.
  // If they drift, dark mode looks different depending on how it was reached.
  const blocks = CSS.split(':root[data-theme="dark"]');
  assert.equal(blocks.length, 2, "expected exactly one explicit dark block");

  const tokensIn = (text: string): string[] =>
    [...text.matchAll(/--([a-z0-9-]+):\s*var\(--d-[a-z0-9-]+\)/g)]
      .map((m) => m[1]!)
      .sort();

  const media = tokensIn(blocks[0]!);
  const explicit = tokensIn(blocks[1]!);
  assert.deepEqual(explicit, media, "the two dark blocks set different tokens");
});

// ------------------------------------------------------------------- module

test("system is the default", () => {
  assert.equal(DEFAULT_THEME, "system");
  assert.deepEqual([...THEME_CHOICES], ["system", "light", "dark"]);
});

test("theme choices are validated", () => {
  assert.equal(isThemeChoice("system"), true);
  assert.equal(isThemeChoice("light"), true);
  assert.equal(isThemeChoice("dark"), true);
  assert.equal(isThemeChoice("sepia"), false);
  assert.equal(isThemeChoice(null), false);
  assert.equal(isThemeChoice(undefined), false);
});

// --------------------------------------------------------- the inline script

test("the init script sets data-theme only for an explicit choice", () => {
  const run = (stored: string | null): string | null => {
    let attribute: string | null = null;
    const sandbox = {
      localStorage: { getItem: () => stored },
      document: {
        documentElement: {
          setAttribute: (_: string, value: string) => {
            attribute = value;
          },
        },
      },
    };
    // Evaluate the real script text, so the test cannot drift from what ships.
    new Function("localStorage", "document", THEME_INIT_SCRIPT)(
      sandbox.localStorage,
      sandbox.document,
    );
    return attribute;
  };

  assert.equal(run("dark"), "dark");
  assert.equal(run("light"), "light");
  // "system" must leave the attribute alone so the CSS media query governs.
  assert.equal(run("system"), null);
  assert.equal(run(null), null);
  assert.equal(run("nonsense"), null);
});

test("the init script survives localStorage throwing", () => {
  // Safari private browsing and blocked site data both throw on access. A
  // theme preference is not worth taking the page down for.
  let attribute: string | null = null;
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError: site data blocked");
    },
  };
  const doc = {
    documentElement: {
      setAttribute: (_: string, v: string) => {
        attribute = v;
      },
    },
  };
  assert.doesNotThrow(() => {
    new Function("localStorage", "document", THEME_INIT_SCRIPT)(throwing, doc);
  });
  assert.equal(attribute, null);
});

test("the init script stays small enough for the critical path", () => {
  // It is inlined into every document, so it is measured rather than assumed.
  assert.ok(THEME_INIT_SCRIPT.length < 300, `${THEME_INIT_SCRIPT.length} bytes`);
  assert.ok(THEME_INIT_SCRIPT.includes(THEME_STORAGE_KEY));
});
