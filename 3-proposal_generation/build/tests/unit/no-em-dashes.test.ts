import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No em dash reaches a screen, a client, or the model.
 *
 * The house rules ban them in generated prose, and the style gate enforces
 * that on Claude's output. Nothing enforced it on the text this project
 * writes itself, and there were seventy-odd: in button labels, error
 * messages, page descriptions, the client covering email, and, most
 * awkwardly, inside the system-prompt line that tells the model not to use
 * em dashes.
 *
 * The prompt case is the one worth stating. A rule and a demonstration in
 * the same paragraph are not equal in weight, and the demonstration usually
 * wins: punctuation the model can see in its own instructions is punctuation
 * it has been shown is acceptable here.
 *
 * COMMENTS ARE EXEMPT. They are for whoever maintains this, they never reach
 * a user or a model, and prose written for a reader who is reading code is a
 * different register from prose written for a client. So are `scripts/` and
 * `tests/`, whose output is read by a developer at a terminal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const EM_DASH = "\u2014";

/**
 * The two places an em dash is load-bearing rather than stylistic: the
 * detector that finds them, and the test fixtures that feed it.
 */
const ALLOWED = new Set(["lib/gates/style.ts", "tests/unit/style.test.ts"]);

/** Words after which a slash opens a regex rather than dividing. */
const KEYWORD_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Blanks comments while preserving line numbers.
 *
 * It tracks string, template AND regex-literal state. The regex case is not
 * hypothetical: `intake.ts` contains `/^[^@,;:<>"[\]\\]+$/`, and a scanner
 * that does not know a regex when it sees one reads that `"` as opening a
 * string and mis-reports every line after it. Getting this wrong in the
 * other direction is the dangerous one, because a scanner that wrongly
 * believes it is inside a comment reports nothing and passes.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  /** The last significant character of code, for the regex-or-divide call. */
  let prev = "";
  /** ...and the word it ended, because `return /re/` is not division. */
  let prevWord = "";
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const next = src[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out.push("  ");
        i += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out.push("  ");
        i += 1;
        continue;
      }
      // A slash is division after a value and a regex after anything else,
      // except that a keyword is not a value: `return /re/.test(x)` is a
      // regex, and reading it as division is what desyncs a naive scanner.
      const afterValue = /[\w$)\]]/.test(prev) && !KEYWORD_BEFORE_REGEX.has(prevWord);
      if (c === "/" && !afterValue) state = "re";
      else if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      if (/[\w$]/.test(c)) prevWord += c;
      else if (!/\s/.test(c)) prevWord = "";
      if (!/\s/.test(c)) prev = c;
      out.push(c);
      continue;
    }
    if (state === "re") {
      if (c === "\\") {
        out.push(c, next);
        i += 1;
        continue;
      }
      // A newline cannot appear in a regex literal; if one does, the guess
      // was wrong and this is division. Recover rather than swallow the file.
      if (c === "\n") {
        state = "code";
        out.push("\n");
        continue;
      }
      if (c === "/") {
        state = "code";
        prev = "/";
        prevWord = "";
      }
      out.push(c);
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out.push("\n");
      } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out.push("  ");
        i += 1;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      continue;
    }
    if (c === "\\") {
      out.push(c, next);
      i += 1;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code";
    }
    out.push(c);
  }
  return out.join("");
}

test("no em dash appears in any string or JSX text the project ships", () => {
  const offenders: string[] = [];

  // Shipped code only. `scripts/` prints to a developer's terminal and
  // `tests/` names its own cases; neither is read by a user or by Claude.
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sources(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!src.includes(EM_DASH)) continue;
      const lines = stripComments(src).split("\n");
      lines.forEach((line, i) => {
        if (line.includes(EM_DASH)) offenders.push(`${rel}:${i + 1}: ${src.split("\n")[i]!.trim()}`);
      });
    }
  }

  assert.deepEqual(offenders, [], `em dashes in shipped text:\n  ${offenders.join("\n  ")}`);
});

test("a quote inside a regex literal does not desync the scanner", () => {
  // The real case, from lib/proposal/intake.ts: an email local-part check
  // whose character class contains a double quote, introduced by `return`
  // so a scanner that only looks at the previous character reads the slash
  // as division and the quote as opening a string.
  const src = [
    String.raw`return /^[^@,;:<>"[\]\\]+$/.test(local);`,
    `// a comment ${EM_DASH} still exempt`,
    `const s = "shipped ${EM_DASH} caught";`,
  ].join("\n");
  const lines = stripComments(src).split("\n");
  assert.equal(lines[1]!.includes(EM_DASH), false, "the comment must stay exempt");
  assert.equal(lines[2]!.includes(EM_DASH), true, "the string must still be caught");
});

test("the comment-stripper does not hide findings behind an apostrophe", () => {
  // The failure this guards against: treating the apostrophe in JSX text as
  // opening a string, which swallows every subsequent line until the next
  // one and silently passes the file.
  const src = [
    "const a = <p>it's fine</p>;",
    `const b = "keep ${EM_DASH} this";`,
  ].join("\n");
  assert.ok(stripComments(src).includes(EM_DASH), "an em dash after an apostrophe must survive");
});

test("comments are exempt, and only comments", () => {
  const src = [
    `// a comment ${EM_DASH} exempt`,
    `/* block ${EM_DASH} exempt */`,
    `const s = "shipped ${EM_DASH} caught";`,
  ].join("\n");
  const lines = stripComments(src).split("\n");
  assert.equal(lines[0]!.includes(EM_DASH), false);
  assert.equal(lines[1]!.includes(EM_DASH), false);
  assert.equal(lines[2]!.includes(EM_DASH), true);
});
