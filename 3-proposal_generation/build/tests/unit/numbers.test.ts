import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMoney,
  extractPercent,
  extractDuration,
  extractDates,
  findUngrounded,
} from "../../lib/gates/numbers";

/**
 * The grounding gate's deterministic half.
 *
 * Two kinds of failure are tested with equal weight, because the gate is
 * useless if it fails either way:
 *
 *   false negatives — an invented figure gets through to a client. This is the
 *   expensive one, and the arithmetic cases (a price split into instalments, a
 *   duration converted to months) are the ones a model actually produces.
 *
 *   false positives — ordinary prose gets flagged, the panel fills with noise,
 *   and the salesperson learns to click past it. A gate nobody reads is not a
 *   gate, so "three phases" and "two teams" must stay silent.
 */

const INTAKE_TEXT = [
  "Estimated pricing: £48,000 fixed fee, invoiced in three milestones.",
  "Proposed timeline: 10 weeks across three phases, starting on signature.",
  "Goals: cut rekeying time by half and remove credit notes.",
  "Date of call: 2026-08-14",
].join("\n");

// -------------------------------------------------------------- extraction

test("money is extracted from the forms people write", () => {
  assert.deepEqual(
    extractMoney("£48,000").map((m) => [m.currency, m.value]),
    [["GBP", 48000]],
  );
  assert.deepEqual(
    extractMoney("$12k").map((m) => [m.currency, m.value]),
    [["USD", 12000]],
  );
  assert.deepEqual(
    extractMoney("NGN 5.5m").map((m) => [m.currency, m.value]),
    [["NGN", 5500000]],
  );
  assert.deepEqual(
    extractMoney("40,000 USD").map((m) => [m.currency, m.value]),
    [["USD", 40000]],
  );
  assert.deepEqual(
    extractMoney("€1,200.50").map((m) => [m.currency, m.value]),
    [["EUR", 1200.5]],
  );
});

test("48k and 48,000 are the same amount", () => {
  const a = extractMoney("£48k")[0];
  const b = extractMoney("£48,000")[0];
  assert.equal(a?.value, b?.value);
});

test("a bare number is not money", () => {
  // Otherwise every "three phases" and "10 weeks" becomes a money finding.
  assert.deepEqual(extractMoney("we will run 3 workshops over 10 weeks"), []);
});

test("percentages are extracted in symbol and word forms", () => {
  assert.deepEqual(extractPercent("a 40% reduction").map((p) => p.value), [40]);
  assert.deepEqual(extractPercent("30 per cent faster").map((p) => p.value), [30]);
  assert.deepEqual(extractPercent("12.5 percent").map((p) => p.value), [12.5]);
});

test("durations are extracted from digits and words, and normalised by unit", () => {
  assert.deepEqual(
    extractDuration("10 weeks").map((d) => [d.value, d.unit]),
    [[10, "week"]],
  );
  assert.deepEqual(
    extractDuration("six weeks").map((d) => [d.value, d.unit]),
    [[6, "week"]],
  );
  assert.deepEqual(
    extractDuration("a 3-month engagement").map((d) => [d.value, d.unit]),
    [[3, "month"]],
  );
  // Plural and abbreviated forms collapse to one canonical unit.
  assert.deepEqual(
    extractDuration("8 wks").map((d) => [d.value, d.unit]),
    [[8, "week"]],
  );
});

test("durations are NOT converted between units during extraction", () => {
  // 10 weeks and 2.5 months must stay distinct, or the gate cannot catch a
  // model that silently restates one as the other.
  const weeks = extractDuration("10 weeks")[0];
  const months = extractDuration("2.5 months")[0];
  assert.notEqual(`${weeks?.value}:${weeks?.unit}`, `${months?.value}:${months?.unit}`);
});

test("dates normalise to ISO across written formats", () => {
  for (const [input, iso] of [
    ["2026-08-14", "2026-08-14"],
    ["14/08/2026", "2026-08-14"],
    ["14 August 2026", "2026-08-14"],
    ["14th Aug 2026", "2026-08-14"],
    ["August 14, 2026", "2026-08-14"],
    ["Q3 2026", "2026-Q3"],
  ] as const) {
    assert.equal(extractDates(input)[0]?.iso, iso, input);
  }
});

test("a month with no year is not treated as a date", () => {
  // "we will start in March" is vague, not fabricated. Flagging it would bury
  // the real findings.
  assert.deepEqual(extractDates("we will start in March"), []);
});

// ------------------------------------------------------ catching inventions

test("a price divided into instalments is caught", () => {
  // The headline case: £48,000 over three milestones is in the intake, and
  // £16,000 per milestone is arithmetic the model was told not to do.
  const findings = findUngrounded(
    "The fee is £48,000, payable as £16,000 per milestone.",
    INTAKE_TEXT,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "money");
  assert.match(findings[0]?.raw ?? "", /16,000/);
});

test("a figure that is present is not flagged", () => {
  assert.deepEqual(findUngrounded("The fee is £48,000 in total.", INTAKE_TEXT), []);
});

test("the right amount in the wrong currency is caught and named as such", () => {
  const findings = findUngrounded("The fee is $48,000.", INTAKE_TEXT);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.reason ?? "", /wrong currency/i);
});

test("a currency-less intake figure matches an output that names the currency", () => {
  // Salesperson shorthand is not the model's invention.
  const findings = findUngrounded("The fee is £40,000.", "Estimated pricing: 40,000 fixed");
  assert.deepEqual(findings, []);
});

test("a converted duration is caught", () => {
  const findings = findUngrounded("Delivery takes 2.5 months.", INTAKE_TEXT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "duration");
  assert.match(findings[0]?.reason ?? "", /not the duration that was given/i);
});

test("the supplied duration passes", () => {
  assert.deepEqual(findUngrounded("Delivery takes 10 weeks.", INTAKE_TEXT), []);
});

test("an invented calendar date is caught", () => {
  const findings = findUngrounded("We will finish by 23 October 2026.", INTAKE_TEXT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "date");
  assert.match(findings[0]?.reason ?? "", /never agreed/i);
});

test("the call date itself is grounded, because the intake contains it", () => {
  assert.deepEqual(findUngrounded("Following our call on 14 August 2026", INTAKE_TEXT), []);
});

test("an invented percentage is caught", () => {
  const findings = findUngrounded("This delivers a 40% efficiency gain.", INTAKE_TEXT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "percent");
});

test("multiple inventions are all reported", () => {
  const findings = findUngrounded(
    "For $60,000 we deliver a 25% gain in 6 months, finishing 1 December 2026.",
    INTAKE_TEXT,
  );
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["date", "duration", "money", "percent"]);
});

// ---------------------------------------------------- avoiding false alarms

test("counts of things are not treated as figures", () => {
  const prose =
    "We will run three workshops with two teams, covering four systems and five reports.";
  assert.deepEqual(findUngrounded(prose, INTAKE_TEXT), []);
});

test("ordinary prose with no numbers produces nothing", () => {
  assert.deepEqual(
    findUngrounded(
      "Thank you for your time. We understand the dispatch team rekeys every note by hand.",
      INTAKE_TEXT,
    ),
    [],
  );
});

test("a figure repeated many times is reported once, not once per mention", () => {
  const findings = findUngrounded(
    "It costs £99,000. To be clear, £99,000 covers everything. £99,000 total.",
    INTAKE_TEXT,
  );
  assert.equal(findings.length, 1, "repetition must not multiply the finding");
});

test("phases and milestones stated in the intake stay unflagged", () => {
  assert.deepEqual(
    findUngrounded(
      "The £48,000 fee is invoiced across three milestones, over 10 weeks in three phases.",
      INTAKE_TEXT,
    ),
    [],
  );
});

test("an empty generated body finds nothing", () => {
  assert.deepEqual(findUngrounded("", INTAKE_TEXT), []);
});

test("an empty allowed set flags any figure that appears", () => {
  const findings = findUngrounded("The fee is £10,000.", "");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "money");
});
