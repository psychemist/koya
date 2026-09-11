import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every hand-written class name and CSS variable used by a component has to
 * exist in the stylesheet.
 *
 * WHY THIS TEST EXISTS. The review comments panel shipped with three names
 * that were never defined: `className="field"` on the composer, a border of
 * `var(--line)` on each comment, and `.badge-neutral` on the section chip.
 * None of them produced an error anywhere. CSS resolves an unknown class to
 * nothing and an unknown variable to nothing, so the textarea silently fell
 * back to the browser default and the panel looked broken next to everything
 * around it, which is exactly how it was reported.
 *
 * That is the whole failure mode: a typo in a class name is invisible to the
 * compiler, invisible to the linter, and invisible in code review, and it
 * surfaces only when a person looks at the screen. It is cheap to catch here.
 *
 * SCOPE. Only names this project defines. Tailwind utilities are generated on
 * demand and never appear in the source stylesheet, so checking every class
 * would flag `gap-2` and `no-underline` on every line. The families below are
 * the ones this codebase owns, chosen because none of them collide with a
 * Tailwind utility prefix — which is why `scroll-y` and `gap-marker` are
 * listed by their full names instead: `scroll-mt-24` and `gap-2` are
 * Tailwind's, and a family rule could not tell them apart.
 *
 * Adding a new component class means adding its family here. That is the
 * cost of the test, and it is one line.
 */

const OUR_FAMILIES = [
  // The type scale. Listed so a typo like `t-md2` fails here rather than
  // rendering at the browser default and looking merely a bit wrong.
  "t",
  "btn",
  "badge",
  "card",
  "panel",
  "field",
  "input",
  "textarea",
  "hint",
  "eyebrow",
  "paper",
  "kbd",
  "mono",
  "seg",
  "skeleton",
  "source",
  "stream",
  "section",
];

/**
 * Full names whose family is shared with a Tailwind utility prefix, or which
 * are one-offs not worth a family of their own.
 *
 * The families above cover a whole prefix at once, which is right for `btn-*`
 * and `badge-*` but wrong for names like `.tbl` or `.steps`: declaring
 * "table" or "step" as a family would flag Tailwind's own `table-auto` and
 * `step-*` utilities on every line that used one. Listing the exact names
 * keeps the check precise.
 */
const OUR_EXACT = [
  "gap-marker",
  "scroll-x",
  "scroll-y",
  "divide-line",
  "prose-doc",
  "page-title",
  "rail-title",
  "rail-section",
  "toolbar",
  "toolbar-group",
  "toolbar-rule",
  "toolbar-cost",
  "filter-bar",
  "filter-chip",
  "filter-count",
  "tbl",
  "tbl-hover",
  "tbl-num",
  "tbl-rowlink",
  "row-link",
  "steps",
  "dropzone",
  "dropzone-input",
  "dropzone-glyph",
  "disclosure",
  "disclosure-caret",
  "action-bar",
  "wordmark",
  "wordmark-koya",
  "wordmark-rule",
  "wordmark-name",
  "nav-main",
  "nav-link",
  "header-divider",
  "account-trigger",
  "avatar",
  "metric",
  "metric-value",
  "metric-detail",
  "menu",
  "menu-head",
  "menu-row",
  "menu-foot",
  "app-header",
  "dot",
  "animate-fade-up",
  "animate-pulse-soft",
];

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const CSS = readFileSync(join(root, "app", "globals.css"), "utf8");

/** Class selectors declared in the stylesheet. */
const DECLARED_CLASSES = new Set(
  [...CSS.matchAll(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)].map((m) => m[1]!),
);

/** Custom properties declared anywhere in the stylesheet. */
const DECLARED_VARS = new Set(
  [...CSS.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
);

const FAMILIES = new Set(OUR_FAMILIES);
const EXACT = new Set(OUR_EXACT);

/**
 * Comments are stripped before scanning.
 *
 * This file's own documentation names the three broken classes it was
 * written for, and a scanner that reads comments would report them forever.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = [
  ...sourceFiles(join(root, "components")),
  ...sourceFiles(join(root, "app")),
];

test("there are components to check", () => {
  assert.ok(FILES.length > 10, `only found ${FILES.length} component files`);
});

test("every project class name used in a component is defined in the stylesheet", () => {
  const missing: string[] = [];

  for (const file of FILES) {
    const src = withoutComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? "";
      // Template holes are conditional Tailwind; the literal words around
      // them are still real class names and are checked.
      for (const name of value.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
        if (name.length === 0) continue;
        if (name.includes("[") || name.includes(":") || name.includes("/")) continue;
        if (DECLARED_CLASSES.has(name)) continue;
        const family = name.split("-")[0]!;
        if (!FAMILIES.has(family) && !EXACT.has(name)) continue;
        missing.push(`${relative(root, file)}: .${name}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `class names with no rule in globals.css:\n  ${missing.join("\n  ")}`,
  );
});

test("every CSS variable referenced from a component is defined", () => {
  const missing: string[] = [];

  for (const file of FILES) {
    const src = withoutComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
      const name = m[1]!;
      if (DECLARED_VARS.has(name)) continue;
      missing.push(`${relative(root, file)}: var(--${name})`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `CSS variables with no declaration in globals.css:\n  ${missing.join("\n  ")}`,
  );
});
