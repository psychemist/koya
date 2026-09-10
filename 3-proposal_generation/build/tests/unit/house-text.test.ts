import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkStyle } from "../../lib/gates/style";
import { deterministicNextSteps } from "../../lib/claude/prompts";
import { renderClientEmail } from "../../lib/delivery/message";
import { COMPLETE_INTAKE } from "../../fixtures/intakes";

/**
 * The text this codebase writes itself has to pass the gate it applies to
 * Claude.
 *
 * WHY. Two sections of every proposal are not generated at all: Next Steps
 * is rendered from a template, and the covering email is rendered from
 * another one. Both were written before the house rules existed, and the
 * first live sample run caught them — the style gate raised two em dashes
 * and a performed sign-off against a section the model never touches.
 *
 * That is a worse failure than the model producing a tell, because a
 * template is identical on every proposal. One bad line in a generated
 * section appears once; one bad line here appears in everything the firm
 * ever sends. And a system that flags a salesperson for writing "looking
 * forward to working together" while itself signing off that way is not
 * enforcing a standard, it is just being inconsistent in public.
 */

const EMAIL_INTAKE = { ...COMPLETE_INTAKE };

function report(findings: ReturnType<typeof checkStyle>): string {
  return findings.map((f) => `${f.kind}: ${f.evidence}`).join("\n  ");
}

test("the Next Steps template passes the style gate", () => {
  const body = deterministicNextSteps(EMAIL_INTAKE);
  const findings = checkStyle([{ key: "next_steps", body }]);
  assert.deepEqual(findings, [], `\n  ${report(findings)}\n`);
});

test("the Next Steps template still says who to contact", () => {
  // Passing the gate by deleting the content would be the wrong fix.
  const body = deterministicNextSteps(EMAIL_INTAKE);
  assert.ok(body.includes(EMAIL_INTAKE.salesperson_name));
  assert.ok(/agreement/i.test(body), "the close has to say what happens if they say yes");
});

test("the client covering email passes the style gate", () => {
  const { bodyText } = renderClientEmail({
    intake: EMAIL_INTAKE,
    proposalLink: "https://example.com/p/token",
  });
  // The greeting and the signature are addressing conventions rather than
  // prose, so the gate runs on what sits between them.
  const body = bodyText
    .split("\n")
    .filter((line) => !/^Hi /.test(line) && !line.startsWith("Koya Talent"))
    .filter((line) => line.trim() !== EMAIL_INTAKE.salesperson_name)
    .join("\n");
  const findings = checkStyle([{ key: "next_steps", body }]);
  assert.deepEqual(findings, [], `\n  ${report(findings)}\n`);
});

test("the covering email still carries the link and the name", () => {
  const { subject, bodyText } = renderClientEmail({
    intake: EMAIL_INTAKE,
    proposalLink: "https://example.com/p/token",
  });
  assert.ok(bodyText.includes("https://example.com/p/token"));
  assert.ok(bodyText.includes(EMAIL_INTAKE.salesperson_name));
  assert.ok(subject.includes(EMAIL_INTAKE.company_name));
});
