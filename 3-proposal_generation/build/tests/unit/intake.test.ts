import test from "node:test";
import assert from "node:assert/strict";
import {
  intakeSchema,
  validateIntake,
  isValidEmail,
  parseLooseDate,
  formatCallDate,
  countWords,
  type Intake,
} from "../../lib/proposal/intake";
// intakeHash lives with the repository, not the validator: it is a SHA-256
// content hash and therefore server-only, whereas validateIntake is
// deliberately dependency-free so it can also run in the browser.
import { generationHash, intakeHash } from "../../lib/proposal/repo";
import { intakeBlock } from "../../lib/claude/prompts";
import { COMPLETE_INTAKE } from "../../fixtures/intakes";

/**
 * The validator is the free half of the missing-information mechanism: every
 * gap it can find costs nothing, and every gap it finds is one Claude is not
 * asked about. So its coverage is worth testing hard, particularly the
 * placeholder cases — those are the ones that look filled-in to everything
 * downstream.
 */

const COMPLETE: Intake = intakeSchema.parse({
  client_name: "Amara Diallo",
  client_email: "amara@meridianlogistics.example",
  company_name: "Meridian Logistics",
  date_of_call: "2026-08-14",
  salesperson_name: "Ada Okonkwo",
  client_needs_summary:
    "Their dispatch team rekeys every delivery note by hand into two systems, and errors are costing them client credits.",
  project_scope:
    "Automate delivery-note capture from email and scan, validate against the order system, and write into both systems.",
  goals_and_objectives: "Cut rekeying time by half and remove credit notes caused by data-entry errors.",
  recommended_services:
    "Discovery workshop, capture pipeline build, validation rules, two-system integration, and handover training.",
  proposed_timeline: "10 weeks across three phases, starting on signature.",
  estimated_pricing: "£48,000 fixed fee, invoiced in three milestones.",
});

function withField(overrides: Partial<Intake>): Intake {
  return { ...COMPLETE, ...overrides };
}

test("a complete intake produces no gaps at all", () => {
  assert.deepEqual(validateIntake(COMPLETE), []);
});

test("each empty commercial field produces exactly one blocking gap", () => {
  for (const field of [
    "project_scope",
    "recommended_services",
    "proposed_timeline",
    "estimated_pricing",
  ] as const) {
    const gaps = validateIntake(withField({ [field]: "" } as Partial<Intake>));
    const mine = gaps.filter((g) => g.field === field);
    assert.equal(mine.length, 1, `${field} should yield one gap, got ${mine.length}`);
    assert.equal(mine[0]?.severity, "blocking", `${field} must block`);
  }
});

test("a blocking gap is attributed to the section it actually breaks", () => {
  const gaps = validateIntake(withField({ estimated_pricing: "" }));
  const pricing = gaps.find((g) => g.field === "estimated_pricing");
  assert.equal(pricing?.sectionKey, "pricing");
});

test("placeholders are still caught, as advisory rather than blocking", () => {
  /**
   * The severity changed here deliberately, and the assertion changed with it
   * rather than being deleted.
   *
   * A form filled in quickly used to come back with six or seven BLOCKING
   * gaps, most of them judgements about wording. A wall of blockers does not
   * produce care; it produces a salesperson who waives all of them without
   * reading, which is worse than a narrower gate they respect. So: an EMPTY
   * field still blocks, because there is nothing to write from. A field that
   * is filled with something we doubt is surfaced and left to the person.
   */
  for (const placeholder of ["TBD", "tbc", "N/A", "n/a", "?", "---", "TODO", "pending", "xxx"]) {
    const gaps = validateIntake(withField({ estimated_pricing: placeholder }));
    const mine = gaps.filter((g) => g.field === "estimated_pricing");
    assert.equal(mine.length, 1, `"${placeholder}" should still be reported`);
    assert.equal(mine[0]?.severity, "advisory");
    assert.match(mine[0]?.message ?? "", /placeholder/i);
  }
});

test("an empty field still blocks, which is the half of the rule that did not change", () => {
  for (const field of [
    "project_scope",
    "recommended_services",
    "proposed_timeline",
    "estimated_pricing",
  ] as const) {
    const gaps = validateIntake(withField({ [field]: "" }));
    const mine = gaps.filter((g) => g.field === field);
    assert.equal(mine.length, 1, `${field} empty should be reported`);
    assert.equal(mine[0]?.severity, "blocking", `${field} empty must still block`);
  }
});

test("a placeholder with a trailing excuse is still a placeholder", () => {
  const gaps = validateIntake(withField({ estimated_pricing: "TBD - waiting on finance" }));
  const mine = gaps.filter((g) => g.field === "estimated_pricing");
  assert.equal(mine.length, 1);
  assert.match(mine[0]?.message ?? "", /placeholder/i);
});

test("a real value that merely contains the letters tbd is not a placeholder", () => {
  // Guards against a regex that matches anywhere in the string.
  const gaps = validateIntake(
    withField({ estimated_pricing: "£40,000, with the tbdX module included" }),
  );
  assert.deepEqual(gaps.filter((g) => g.field === "estimated_pricing"), []);
});

test("pricing with no figure is reported, as advisory", () => {
  // A price that names no number is a quality judgement about an answer that
  // is present, not a missing fact. Surfaced, counted, and left to the person.
  const gaps = validateIntake(withField({ estimated_pricing: "competitive and negotiable" }));
  const mine = gaps.filter((g) => g.field === "estimated_pricing");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.severity, "advisory");
  assert.match(mine[0]?.message ?? "", /no figure/i);
});

test("pricing expressed as a range is accepted", () => {
  assert.deepEqual(
    validateIntake(withField({ estimated_pricing: "£40,000-£55,000 depending on scope" })).filter(
      (g) => g.field === "estimated_pricing",
    ),
    [],
  );
});

test("a timeline with no duration is advisory, not blocking", () => {
  const gaps = validateIntake(withField({ proposed_timeline: "as soon as possible" }));
  const mine = gaps.filter((g) => g.field === "proposed_timeline");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.severity, "advisory");
});

test("duration formats a salesperson actually types are all recognised", () => {
  for (const t of [
    "10 weeks",
    "3 months",
    "90 days",
    "Q3 delivery",
    "six weeks",
    "two sprints",
    "1 year",
    "8 wks",
  ]) {
    const gaps = validateIntake(withField({ proposed_timeline: t })).filter(
      (g) => g.field === "proposed_timeline",
    );
    assert.deepEqual(gaps, [], `"${t}" should read as a duration`);
  }
});

test("missing goals is advisory — the proposal is weaker but still honest", () => {
  const gaps = validateIntake(withField({ goals_and_objectives: "" }));
  const mine = gaps.filter((g) => g.field === "goals_and_objectives");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.severity, "advisory");
});

test("a needs summary that is long enough but says nothing still blocks", () => {
  const gaps = validateIntake(
    withField({ client_needs_summary: "they want the thing done quickly" }),
  );
  const mine = gaps.filter((g) => g.field === "client_needs_summary");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.severity, "blocking");
});

test("client email is advisory when drafting and blocking when delivering", () => {
  const draft = validateIntake(withField({ client_email: "" }));
  const delivery = validateIntake(withField({ client_email: "" }), { forDelivery: true });
  assert.equal(draft.find((g) => g.field === "client_email")?.severity, "advisory");
  assert.equal(delivery.find((g) => g.field === "client_email")?.severity, "blocking");
});

test("an invalid email is reported with its own message", () => {
  const gaps = validateIntake(withField({ client_email: "amara at example dot com" }));
  const mine = gaps.find((g) => g.field === "client_email");
  assert.match(mine?.message ?? "", /not a valid address/i);
});

test("a future call date is flagged for checking", () => {
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const gaps = validateIntake(withField({ date_of_call: future }));
  const mine = gaps.find((g) => g.field === "date_of_call");
  assert.match(mine?.message ?? "", /future/i);
});

test("an unreadable call date is flagged but printed as written", () => {
  const gaps = validateIntake(withField({ date_of_call: "last Tuesday-ish" }));
  const mine = gaps.find((g) => g.field === "date_of_call");
  assert.match(mine?.message ?? "", /could not be read/i);
  assert.equal(formatCallDate("last Tuesday-ish"), "last Tuesday-ish");
});

test("gap fingerprints are unique within one validation run", () => {
  const gaps = validateIntake(
    intakeSchema.parse({
      client_name: "A Client",
      company_name: "A Company",
      salesperson_name: "A Seller",
      client_needs_summary:
        "They described a long-standing problem with manual work across two teams and want it reduced.",
    }),
  );
  const prints = gaps.map((g) => g.fingerprint);
  assert.equal(new Set(prints).size, prints.length, "fingerprints must not collide");
  assert.ok(gaps.length >= 4, "an almost-empty intake should surface several gaps");
});

// ------------------------------------------------------------------- helpers

test("email validation accepts real addresses and rejects malformed ones", () => {
  for (const good of ["a@b.co", "first.last@sub.domain.example", "x+tag@d.io"]) {
    assert.equal(isValidEmail(good), true, good);
  }
  for (const bad of ["", "a@b", "a b@c.com", "a@@b.com", "@b.com", "a@.com", "a@b..com", "a@b."]) {
    assert.equal(isValidEmail(bad), false, JSON.stringify(bad));
  }
});

test("dates are read day-first, and impossible dates are rejected not rolled over", () => {
  assert.equal(parseLooseDate("2026-08-14")?.toISOString().slice(0, 10), "2026-08-14");
  assert.equal(parseLooseDate("14/08/2026")?.toISOString().slice(0, 10), "2026-08-14");
  assert.equal(parseLooseDate("14-08-26")?.toISOString().slice(0, 10), "2026-08-14");
  // 31 February must not silently become 2 March.
  assert.equal(parseLooseDate("31/02/2026"), null);
  assert.equal(parseLooseDate("00/01/2026"), null);
  assert.equal(parseLooseDate("14/13/2026"), null);
  assert.equal(parseLooseDate("not a date"), null);
  assert.equal(parseLooseDate(""), null);
});

test("named-month dates parse in either order", () => {
  assert.equal(parseLooseDate("14 Aug 2026")?.getUTCMonth(), 7);
  assert.equal(parseLooseDate("August 14, 2026")?.getUTCMonth(), 7);
});

test("the intake hash ignores key order but tracks value changes", () => {
  const a = intakeHash(COMPLETE);
  const reordered = intakeSchema.parse(
    Object.fromEntries(Object.entries(COMPLETE).reverse()) as Record<string, string>,
  );
  assert.equal(intakeHash(reordered), a, "key order must not change the hash");
  assert.notEqual(intakeHash(withField({ estimated_pricing: "£49,000" })), a);
});

test("word counting handles padding and multiple spaces", () => {
  assert.equal(countWords("  one   two \n three "), 3);
  assert.equal(countWords("   "), 0);
});

test("the schema rejects an intake missing its hard-required fields", () => {
  const result = intakeSchema.safeParse({ client_name: "A" });
  assert.equal(result.success, false);
});

test("the schema trims whitespace so a spaces-only field reads as empty", () => {
  const parsed = intakeSchema.parse({ ...COMPLETE, estimated_pricing: "     " });
  assert.equal(parsed.estimated_pricing, "");
  const gaps = validateIntake(parsed).filter((g) => g.field === "estimated_pricing");
  assert.equal(gaps.length, 1, "a whitespace-only price must be treated as absent");
});

/* ------------------------------- what actually reaches the model ---------- */

test("the client's email address never reaches a prompt", () => {
  /**
   * WHY THIS TEST EXISTS. Every draft, every section regeneration and every
   * gap analysis sends the intake block to the Anthropic API. It carried
   * `client_email`, so a real person's address left this system on each of
   * those calls in exchange for nothing: the model has no use for it, no
   * section quotes an address, and the house rules forbid inventing contact
   * details anyway.
   *
   * All three paths go through `intakeBlock`, so this one assertion covers
   * them. It is written against a distinctive address rather than against the
   * field list, because the thing to prevent is the VALUE escaping, whatever
   * route it takes to get there.
   */
  const block = intakeBlock(
    intakeSchema.parse({
      ...COMPLETE_INTAKE,
      client_email: "do-not-send-me@client.invalid",
    }),
  );

  assert.ok(!block.includes("do-not-send-me@client.invalid"), "the address reached the prompt");
  assert.ok(!block.includes("client.invalid"), "the client's domain reached the prompt");
  // The fields the prose genuinely needs are still there.
  assert.ok(block.includes(COMPLETE_INTAKE.client_name));
  assert.ok(block.includes(COMPLETE_INTAKE.company_name));
  assert.ok(block.includes(COMPLETE_INTAKE.client_needs_summary.slice(0, 40)));
});

test("changing the email does not invalidate the generation cache", () => {
  // The hash covers what the model was shown. An address it never saw cannot
  // make an identical draft worth paying for twice, and must not set off the
  // stale-draft warning on the deliver page either.
  const base = { sourceTexts: [], promptVersion: "v1", model: "claude-opus-5" };
  const before = generationHash({ ...base, intake: COMPLETE_INTAKE });
  const after = generationHash({
    ...base,
    intake: intakeSchema.parse({ ...COMPLETE_INTAKE, client_email: "someone.else@other.invalid" }),
  });
  assert.equal(before, after);

  // A field the prose DOES use still invalidates it.
  const scoped = generationHash({
    ...base,
    intake: intakeSchema.parse({ ...COMPLETE_INTAKE, project_scope: "Something quite different." }),
  });
  assert.notEqual(before, scoped);
});
