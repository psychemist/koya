import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkStyle, type StyleFinding } from "../../lib/gates/style";
import { VOICE_EXAMPLES } from "../../lib/claude/exemplars";

/**
 * The style gate, and a check that the exemplars shipped in the prompt are
 * consistent with the rules the gate enforces. A house style whose own
 * examples fail its own linter teaches the model the wrong thing twice.
 */

function kinds(findings: StyleFinding[]): string[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

function check(body: string) {
  return checkStyle([{ key: "introduction", body }]);
}

test("good prose raises nothing", () => {
  const body = `Priya described referrals arriving by fax, by email and by phone, then getting lost between the three.

We would fix that first. Across nine sites you would have one place where every referral lands, and a number you can look at each morning before the clinics open.`;
  assert.deepEqual(check(body), [], JSON.stringify(check(body), null, 2));
});

test("stock vocabulary is caught with a concrete replacement", () => {
  const findings = check("We will leverage our robust platform to streamline your operations.");
  const hits = findings.filter((f) => f.kind === "banned_phrase");
  assert.equal(hits.length, 3);
  // The message has to say what to write instead, or it is just a complaint.
  assert.ok(hits.every((f) => f.message.includes("Try:")));
  assert.ok(hits.some((f) => f.evidence === "leverage"));
});

test("filler openings are caught", () => {
  const f = check("In today's fast-paced business landscape, efficiency matters.");
  assert.ok(f.some((x) => x.kind === "banned_phrase"));
});

test("hedges on a commitment are caught", () => {
  const f = check("We would aim to deliver the audit by week six. We should be able to help.");
  assert.equal(f.filter((x) => x.kind === "hedging").length, 2);
});

test("writing about the document instead of the client is caught", () => {
  const f = check("This section outlines our approach to your referral problem.");
  assert.ok(f.some((x) => x.kind === "self_reference"));
});

test("flat sentence rhythm is caught", () => {
  // Six sentences, all nine words. Individually fine, collectively machine-set.
  const body = Array.from(
    { length: 6 },
    (_, i) => `We will review the intake process at site ${i + 1}.`,
  ).join(" ");
  const f = check(body);
  assert.ok(f.some((x) => x.kind === "uniform_rhythm"), JSON.stringify(kinds(f)));
});

test("bursty rhythm passes", () => {
  const body = `Referrals get lost. You said that on the call, and you were specific about where: between the fax machine at reception and whoever happens to pick the list up, which on a bad week is nobody at all. We would start there.`;
  assert.ok(!check(body).some((x) => x.kind === "uniform_rhythm"));
});

test("the rule of three is only flagged when it becomes the shape of the writing", () => {
  const once = check(
    "The audit covers intake, triage, and booking. We would start at Ashford in week one.",
  );
  assert.ok(!once.some((x) => x.kind === "rule_of_three"), "one tricolon is a good sentence");

  const always = check(
    "It is faster, cheaper, and more reliable. We will review, refine, and rebuild. You get clarity, control, and confidence.",
  );
  assert.ok(always.some((x) => x.kind === "rule_of_three"));
});

test("any em dash is caught, because house style has none", () => {
  // This was a density check: one em dash was a choice, six were a habit. The
  // tone guide removed the choice, and a gate looser than the prompt teaches
  // the writer that the prompt is negotiable.
  const one = check("Referrals get lost — you said so on the call. We would fix the intake first.");
  const finding = one.find((x) => x.kind === "em_dash");
  assert.ok(finding, "a single em dash is still a finding");
  assert.ok(finding.evidence.includes("1 em dash"));

  const several = check("We would start — as you suggested — at Ashford. The audit runs ten weeks — no longer.");
  assert.ok(several.some((x) => x.kind === "em_dash" && x.evidence.includes("3 em dashes")));

  assert.ok(!check("Referrals get lost. You said so on the call.").some((x) => x.kind === "em_dash"));
});

test("two sections opening the same way is caught across the document", () => {
  const f = checkStyle([
    { key: "introduction", body: "We will work with your team to fix the intake process." },
    { key: "project_scope", body: "We will work across three sites during the pilot." },
  ]);
  const repeated = f.filter((x) => x.kind === "repeated_opener");
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]!.sectionKey, "document");
});

test("gap markers and citations cannot trip a prose check", () => {
  // A marker is machinery, not writing. Its words must not be linted.
  const f = check("The fee is [NEEDS INPUT: what is the total, in order to invoice?] per phase.");
  assert.deepEqual(f, []);
});

test("an empty section is skipped rather than flagged", () => {
  assert.deepEqual(checkStyle([{ key: "pricing", body: "   " }]), []);
});

test("every finding names its section and quotes its evidence", () => {
  for (const f of check("We will leverage a comprehensive solution.")) {
    assert.ok(f.sectionKey.length > 0);
    assert.ok(f.evidence.length > 0, "a finding with no evidence is unactionable");
    assert.ok(f.message.length > 0);
  }
});

// ------------------------------------------------- the syntax of AI prose
//
// The checks above catch vocabulary and rhythm. These catch sentence shapes:
// the constructions that survive every word-level filter and are the reason a
// fluent proposal still reads as machine-written.

test("stacked verbless fragments are caught", () => {
  const f = check("The pilot runs at three sites. Twelve weeks. Three phases. You would see the first backlog count in week two.");
  const hit = f.find((x) => x.kind === "parataxis");
  assert.ok(hit, JSON.stringify(kinds(f)));
  assert.ok(hit.evidence.includes("Twelve weeks"));
});

test("a single fragment is a choice, not a pattern", () => {
  assert.ok(!check("Referrals get lost. Every day. We would start by counting them at Ashford before anything else changes.").some((x) => x.kind === "parataxis"));
});

test("a short clause is not a fragment, whatever verb it uses", () => {
  // The verb list inside the gate cannot be exhaustive, and its gaps used to
  // surface as false slogans: "You revise, section by section." was reported
  // as parataxis because `revise` was not on the list. A pronoun subject
  // settles it, since the constructions this catches are noun phrases.
  const f = check("You revise, section by section. We rework it. They sign it off.");
  assert.ok(!f.some((x) => x.kind === "parataxis"), JSON.stringify(kinds(f)));
});

test("a verbless sentence that is itself a list of beats is caught", () => {
  const f = check("Nine sites, one workflow, total visibility. You would see the count each morning.");
  assert.ok(f.some((x) => x.kind === "parataxis"), JSON.stringify(kinds(f)));
});

test("bullet lists are not parataxis", () => {
  // A verbless noun phrase is the correct form for a deliverable, not a tell.
  const f = checkStyle([
    {
      key: "deliverables",
      body: "- One intake workflow\n- A daily backlog count\n- A half-day handover",
    },
  ]);
  assert.ok(!f.some((x) => x.kind === "parataxis"), JSON.stringify(kinds(f)));
});

test("corrective negation is caught in both of its shapes", () => {
  assert.ok(
    check("This is not simply a process fix. It is a change in how the sites talk to each other.").some(
      (x) => x.kind === "corrective_negation",
    ),
  );
  assert.ok(
    check("We would not just count the referrals, but give the site leads somewhere to act on them.").some(
      (x) => x.kind === "corrective_negation",
    ),
  );
});

test("consecutive sentences built the same way are caught", () => {
  const f = check("We would map the intake at Ashford. We would rebuild it at Beckton and Croft.");
  assert.ok(f.some((x) => x.kind === "parallel_structure"), JSON.stringify(kinds(f)));
});

test("negative anaphora is the same finding", () => {
  const f = check("No new software for the site leads. No new forms for reception to fill in.");
  assert.ok(f.some((x) => x.kind === "parallel_structure"), JSON.stringify(kinds(f)));
});

test("a mirrored clause inside one sentence is caught", () => {
  const f = check("A backlog you cannot see is a backlog you cannot staff for.");
  const hit = f.find((x) => x.kind === "mirrored_clause");
  assert.ok(hit, JSON.stringify(kinds(f)));
  assert.ok(hit.evidence.includes("backlog you cannot"));
});

test("ordinary repetition of function words is not a mirrored clause", () => {
  assert.ok(
    !check("The audit covers the intake desk at each of the nine sites in the group.").some(
      (x) => x.kind === "mirrored_clause",
    ),
  );
});

test("filler intensifiers are caught", () => {
  const f = check("The count is genuinely the thing that matters, and it is really the first step.");
  assert.equal(f.filter((x) => x.kind === "intensifier").length, 2);
});

test("performed enthusiasm is caught", () => {
  assert.ok(check("We are excited to partner with Northgate on this work.").some((x) => x.kind === "performed_enthusiasm"));
  assert.ok(check("We look forward to hearing from you.").some((x) => x.kind === "performed_enthusiasm"));
});

test("nominalisation is caught", () => {
  const f = check("The implementation of the workflow happens in week three at all nine of the sites.");
  assert.ok(f.some((x) => x.kind === "nominalisation"), JSON.stringify(kinds(f)));
});

test("throat-clearing is caught at the top of a section and nowhere else", () => {
  assert.ok(check("Thank you for your time on the call about referrals across the nine sites.").some((x) => x.kind === "throat_clearing"));
  // Mid-section the same words are ordinary connective tissue.
  assert.ok(
    !check("The count comes first at Ashford. As discussed with your site leads, Beckton follows in week four.").some(
      (x) => x.kind === "throat_clearing",
    ),
  );
});

test("a landing beat at the end of a paragraph is caught", () => {
  const f = check("We would put every referral into one place and give you a count each morning. That is the difference.");
  assert.ok(f.some((x) => x.kind === "summary_beat"), JSON.stringify(kinds(f)));
});

test("relative time references are caught, because the writer cannot know the date", () => {
  // The reported bug: an intake dated 09/01/26 produced "thanks for the call
  // today" on 09/10/26. The model has no clock, so it must never reach for one.
  assert.ok(check("Thanks for the call today about the referral backlog.").some((x) => x.kind === "relative_time"));
  assert.ok(check("You mentioned last Tuesday that nobody can count the backlog.").some((x) => x.kind === "relative_time"));
  assert.ok(check("We would deliver the audit in the coming weeks.").some((x) => x.kind === "relative_time"));
  // A real date is fine.
  assert.ok(!check("We would deliver the audit by 14 November 2026.").some((x) => x.kind === "relative_time"));
});

// ---------------------------------------------------------------- exemplars

test("the GOOD exemplars in the prompt pass the gate", () => {
  // Extracted from the shipped block rather than duplicated, so the two cannot
  // drift apart: if someone edits an example into breaking the rules, this
  // fails rather than quietly teaching the model the wrong register.
  const good = section(VOICE_EXAMPLES, "## Introduction, written well", "Why this works.");
  const findings = checkStyle([{ key: "introduction", body: good }]);
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
});

test("the BAD exemplars in the prompt are caught by the gate", () => {
  // The examples and the gate have to agree on what bad looks like. If the
  // gate cannot see anything wrong with the prose the prompt holds up as a
  // failure, one of the two is wrong.
  const bad = section(VOICE_EXAMPLES, "## Introduction, written badly", "Why this fails");
  const findings = checkStyle([{ key: "introduction", body: bad }]);
  assert.ok(findings.length >= 4, `expected several findings, got ${findings.length}`);
  assert.ok(findings.some((f) => f.kind === "banned_phrase"));
});

test("the exemplar block quotes the client's own words back", () => {
  assert.ok(VOICE_EXAMPLES.includes("Priya"));
  assert.ok(VOICE_EXAMPLES.includes("unactioned"), "the good example must reuse the intake wording");
});

function section(block: string, from: string, to: string): string {
  const start = block.indexOf(from);
  assert.ok(start >= 0, `missing heading: ${from}`);
  const end = block.indexOf(to, start);
  assert.ok(end > start, `missing terminator: ${to}`);
  return block.slice(start + from.length, end).trim();
}
