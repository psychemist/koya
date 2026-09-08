import test from "node:test";
import assert from "node:assert/strict";
import {
  SectionStreamParser,
  parseSectionedOutput,
  extractGaps,
  extractCitationIndices,
  stripGapMarkers,
  stripCitationMarkers,
  hasGapMarker,
} from "../../lib/proposal/parse";
import { AI_SECTION_KEYS, SECTION_KEYS } from "../../lib/proposal/sections";
import { sectionMarker } from "../../lib/claude/prompts";

/**
 * The streaming parser is the component most likely to fail in production and
 * least likely to fail in a happy-path demo: it only misbehaves when the
 * network splits a marker, which depends on packet timing. So it is tested
 * against every split point rather than a few plausible ones.
 */

const SAMPLE =
  `${sectionMarker("introduction")}\nThank you for your time.\n\n` +
  `${sectionMarker("project_scope")}\nIn scope: one thing.\n\n` +
  `${sectionMarker("pricing")}\n**$12,000** fixed fee.\n`;

test("whole-response parse assigns each body to its section", () => {
  const parsed = parseSectionedOutput(SAMPLE, ["introduction", "project_scope", "pricing"]);
  assert.equal(parsed.bodies.introduction, "Thank you for your time.");
  assert.equal(parsed.bodies.project_scope, "In scope: one thing.");
  assert.equal(parsed.bodies.pricing, "**$12,000** fixed fee.");
  assert.deepEqual(parsed.missing, []);
  assert.deepEqual(parsed.unknownMarkers, []);
  assert.equal(parsed.preamble, "");
});

test("streaming in one-character chunks yields the same result as one chunk", () => {
  const parser = new SectionStreamParser();
  const acc: Record<string, string> = {};
  for (const ch of SAMPLE) {
    for (const d of parser.push(ch)) acc[d.key] = (acc[d.key] ?? "") + d.delta;
  }
  for (const d of parser.end()) acc[d.key] = (acc[d.key] ?? "") + d.delta;

  assert.equal(acc.introduction?.trim(), "Thank you for your time.");
  assert.equal(acc.project_scope?.trim(), "In scope: one thing.");
  assert.equal(acc.pricing?.trim(), "**$12,000** fixed fee.");
});

test("no marker fragment ever leaks into an emitted body, at any split point", () => {
  // This is the real-world failure: a chunk boundary inside "<<<SECTION:" or
  // inside its ">>>" terminator. Every boundary is exercised.
  for (let split = 0; split <= SAMPLE.length; split += 1) {
    const parser = new SectionStreamParser();
    const acc: Record<string, string> = {};
    const chunks = [SAMPLE.slice(0, split), SAMPLE.slice(split)];
    for (const c of chunks) {
      for (const d of parser.push(c)) acc[d.key] = (acc[d.key] ?? "") + d.delta;
    }
    for (const d of parser.end()) acc[d.key] = (acc[d.key] ?? "") + d.delta;

    for (const [key, body] of Object.entries(acc)) {
      assert.ok(
        !body.includes("<<<") && !body.includes(">>>") && !body.includes("SECTION:"),
        `split at ${split} leaked a marker into ${key}: ${JSON.stringify(body)}`,
      );
    }
    assert.equal(acc.pricing?.trim(), "**$12,000** fixed fee.", `split at ${split}`);
  }
});

test("three-way splits across markers stay clean", () => {
  for (let a = 0; a < SAMPLE.length; a += 7) {
    for (let b = a; b < SAMPLE.length; b += 11) {
      const parser = new SectionStreamParser();
      const acc: Record<string, string> = {};
      for (const c of [SAMPLE.slice(0, a), SAMPLE.slice(a, b), SAMPLE.slice(b)]) {
        for (const d of parser.push(c)) acc[d.key] = (acc[d.key] ?? "") + d.delta;
      }
      for (const d of parser.end()) acc[d.key] = (acc[d.key] ?? "") + d.delta;
      assert.ok(!(acc.introduction ?? "").includes("<<<"), `splits ${a},${b}`);
      assert.equal(acc.pricing?.trim(), "**$12,000** fixed fee.", `splits ${a},${b}`);
    }
  }
});

test("missing sections are reported, not silently accepted", () => {
  const parsed = parseSectionedOutput(
    `${sectionMarker("introduction")}\nHello.\n`,
    ["introduction", "pricing"],
  );
  assert.deepEqual(parsed.missing, ["pricing"]);
});

test("an empty section body counts as missing", () => {
  const parsed = parseSectionedOutput(
    `${sectionMarker("introduction")}\nHello.\n${sectionMarker("pricing")}\n   \n`,
    ["introduction", "pricing"],
  );
  assert.deepEqual(parsed.missing, ["pricing"]);
});

test("an unknown marker is recorded and its text is not lost", () => {
  const parsed = parseSectionedOutput(
    `${sectionMarker("introduction")}\nReal text.\n<<<SECTION:invented_section>>>\nStray text.\n`,
    ["introduction"],
  );
  assert.deepEqual(parsed.unknownMarkers, ["invented_section"]);
  // Stray text stays attached to the last known section rather than vanishing.
  assert.match(parsed.bodies.introduction ?? "", /Stray text\./);
});

test("preamble before the first marker is captured, not treated as a section", () => {
  const parsed = parseSectionedOutput(
    `Here is your proposal!\n${sectionMarker("introduction")}\nHello.\n`,
    ["introduction"],
  );
  assert.equal(parsed.preamble, "Here is your proposal!");
  assert.equal(parsed.bodies.introduction, "Hello.");
});

test("every AI section key round-trips through its own marker", () => {
  const text = AI_SECTION_KEYS.map((k) => `${sectionMarker(k)}\nBody of ${k}.`).join("\n\n");
  const parsed = parseSectionedOutput(text, AI_SECTION_KEYS);
  assert.deepEqual(parsed.missing, []);
  for (const k of AI_SECTION_KEYS) {
    assert.equal(parsed.bodies[k], `Body of ${k}.`);
  }
});

// ---------------------------------------------------------------- gap markers

test("gap markers become blocking gaps carrying the model's question", () => {
  const gaps = extractGaps("pricing", "The fee is [NEEDS INPUT: is this per month or fixed?] total.");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.severity, "blocking");
  assert.equal(gaps[0]?.detectedBy, "model");
  assert.equal(gaps[0]?.message, "is this per month or fixed?");
  assert.equal(gaps[0]?.sectionKey, "pricing");
});

test("nested brackets inside a gap marker do not truncate the question", () => {
  const gaps = extractGaps("pricing", "[NEEDS INPUT: which rate (day or hour) applies?]");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.message, "which rate (day or hour) applies?");
});

test("square brackets inside a gap marker are balanced correctly", () => {
  const gaps = extractGaps("timeline", "[NEEDS INPUT: confirm the [start date] with the client]");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.message, "confirm the [start date] with the client");
});

test("multiple gap markers in one body are all extracted", () => {
  const gaps = extractGaps(
    "deliverables",
    "First [NEEDS INPUT: how many workshops?] then [NEEDS INPUT: who attends?] done.",
  );
  assert.equal(gaps.length, 2);
  assert.deepEqual(
    gaps.map((g) => g.message),
    ["how many workshops?", "who attends?"],
  );
});

test("an unterminated gap marker is itself reported as a blocking gap", () => {
  const gaps = extractGaps("pricing", "The fee is [NEEDS INPUT: what is the");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.severity, "blocking");
  assert.match(gaps[0]?.message ?? "", /unterminated/i);
});

test("an empty gap marker is ignored rather than creating a contentless gap", () => {
  assert.deepEqual(extractGaps("pricing", "Fee [NEEDS INPUT: ] here."), []);
});

test("gap fingerprints are stable and distinguish different questions", () => {
  const a = extractGaps("pricing", "[NEEDS INPUT: what is the rate?]")[0];
  const b = extractGaps("pricing", "[NEEDS INPUT: what is the rate?]")[0];
  const c = extractGaps("pricing", "[NEEDS INPUT: what is the term?]")[0];
  assert.equal(a?.fingerprint, b?.fingerprint, "same question must dedupe");
  assert.notEqual(a?.fingerprint, c?.fingerprint, "different questions must not collide");
});

test("whitespace in a question is normalised so re-runs dedupe", () => {
  const a = extractGaps("pricing", "[NEEDS INPUT: what   is\n the rate?]")[0];
  const b = extractGaps("pricing", "[NEEDS INPUT: what is the rate?]")[0];
  assert.equal(a?.message, b?.message);
  assert.equal(a?.fingerprint, b?.fingerprint);
});

test("hasGapMarker detects an open gap", () => {
  assert.equal(hasGapMarker("clean text"), false);
  assert.equal(hasGapMarker("a [NEEDS INPUT: q?] b"), true);
});

// ----------------------------------------------------------------- citations

test("citation indices are extracted, deduplicated and ordered", () => {
  const idx = extractCitationIndices(
    "Claim one [[source:2]]. Claim two [[source:1]]. Again [[source:2]].",
  );
  assert.deepEqual(idx, [2, 1]);
});

test("malformed citation markers are ignored", () => {
  assert.deepEqual(extractCitationIndices("[[source:]] [[source:abc]] [source:1] [[source:0]]"), []);
});

// ------------------------------------------------------------------ stripping

test("stripping gap markers leaves readable prose", () => {
  const out = stripGapMarkers("The fee is [NEEDS INPUT: fixed or monthly?] and covers setup.");
  assert.equal(out, "The fee is and covers setup.");
  assert.ok(!out.includes("NEEDS INPUT"));
});

test("stripping an unterminated gap marker drops the tail rather than leaking it", () => {
  const out = stripGapMarkers("Body text [NEEDS INPUT: unfinished");
  assert.equal(out, "Body text");
});

test("stripping citation markers leaves no double spaces", () => {
  const out = stripCitationMarkers("They use Sage [[source:1]] for accounting.");
  assert.equal(out, "They use Sage for accounting.");
});

test("section key list and AI section list stay in sync with the template", () => {
  // next_steps is deterministic, so it is the one key absent from AI_SECTION_KEYS.
  assert.equal(SECTION_KEYS.length, AI_SECTION_KEYS.length + 1);
  assert.ok(SECTION_KEYS.includes("next_steps"));
  assert.ok(!AI_SECTION_KEYS.includes("next_steps"));
});
