import test from "node:test";
import assert from "node:assert/strict";
import {
  LINK_PLACEHOLDER,
  applyProposalLink,
  renderClientEmail,
  firstNameOf,
  buildEml,
} from "../../lib/delivery/message";
import { deliveryIdempotencyKey, isRecipientRefusal } from "../../lib/delivery/send";
import { config } from "../../lib/config";
import {
  FALLBACK_OPENER,
  isAcceptableOpener,
  openerHash,
} from "../../lib/delivery/opener";
import { COMPLETE_INTAKE } from "../../fixtures/intakes";

const LINK = "https://proposals.example/p/abc123";

/** The line the generated opener replaces. */
const TEMPLATED_FIRST_LINE = FALLBACK_OPENER;

test("the client email follows the template and substitutes correctly", () => {
  const { subject, bodyText } = renderClientEmail({ intake: COMPLETE_INTAKE, proposalLink: LINK });
  assert.equal(subject, "Proposal for Meridian Logistics");
  assert.match(bodyText, /^Hi Amara,/);
  assert.ok(bodyText.includes(LINK), "the proposal link must appear in the body");
  assert.match(bodyText, /Ada Okonkwo/);
  assert.match(bodyText, /Koya Talent$/);
  // No unsubstituted placeholders should survive.
  assert.ok(!bodyText.includes("{{"), bodyText.slice(0, 80));
});

test("greeting names are extracted sensibly", () => {
  assert.equal(firstNameOf("Amara Diallo"), "Amara");
  assert.equal(firstNameOf("Priya"), "Priya");
  // A title alone would read as "Hi Dr", so the surname comes along.
  assert.equal(firstNameOf("Dr Priya Raman"), "Dr Raman");
  assert.equal(firstNameOf("Dr. Priya Raman"), "Dr Raman");
  assert.equal(firstNameOf("   "), "there");
  assert.equal(firstNameOf(""), "there");
});

// ------------------------------------------------------------- idempotency

test("the same send produces the same idempotency key", () => {
  const base = {
    proposalId: "p1",
    recipient: "a@b.example",
    subject: "Proposal for X",
    bodyText: "Hello",
  };
  assert.equal(deliveryIdempotencyKey(base), deliveryIdempotencyKey(base));
});

test("recipient case and padding do not create a second delivery", () => {
  const a = deliveryIdempotencyKey({
    proposalId: "p1",
    recipient: "Amara@Example.com",
    subject: "S",
    bodyText: "B",
  });
  const b = deliveryIdempotencyKey({
    proposalId: "p1",
    recipient: "  amara@example.com ",
    subject: "S",
    bodyText: "B",
  });
  assert.equal(a, b);
});

test("an edited covering note IS a new send, not a suppressed duplicate", () => {
  // The client would be receiving different words, so it must be allowed
  // through rather than silently swallowed as a repeat.
  const a = deliveryIdempotencyKey({
    proposalId: "p1",
    recipient: "a@b.example",
    subject: "S",
    bodyText: "First version",
  });
  const b = deliveryIdempotencyKey({
    proposalId: "p1",
    recipient: "a@b.example",
    subject: "S",
    bodyText: "Second version",
  });
  assert.notEqual(a, b);
});

test("different proposals to the same address never share a key", () => {
  const a = deliveryIdempotencyKey({ proposalId: "p1", recipient: "x@y.z", subject: "S", bodyText: "B" });
  const b = deliveryIdempotencyKey({ proposalId: "p2", recipient: "x@y.z", subject: "S", bodyText: "B" });
  assert.notEqual(a, b);
});

// -------------------------------------------------------------------- .eml

test("a plain .eml has the required headers and a decodable body", () => {
  const eml = buildEml({
    from: "Koya Talent <no-reply@example.com>",
    to: "amara@example.com",
    subject: "Proposal for Meridian Logistics",
    bodyText: "Hi Amara,\n\nThe fee is £48,000.\n",
    attachment: null,
  });

  assert.match(eml, /^From: Koya Talent <no-reply@example\.com>\r\n/);
  assert.match(eml, /\r\nTo: amara@example\.com\r\n/);
  assert.match(eml, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(eml, /charset="utf-8"/);
  assert.match(eml, /Content-Transfer-Encoding: quoted-printable/);
  // £ must be encoded, or the client shows "Â£48,000".
  assert.ok(!eml.includes("£48,000"), "the pound sign must be quoted-printable encoded");
  assert.match(eml, /=C2=A348,000/);
});

test("quoted-printable never emits a line longer than 76 characters", () => {
  const long = `Hi there, ${"this is a long sentence that must be soft-wrapped by the encoder. ".repeat(6)}`;
  const eml = buildEml({
    from: "a@b.example",
    to: "c@d.example",
    subject: "S",
    bodyText: long,
    attachment: null,
  });
  for (const line of eml.split("\r\n")) {
    assert.ok(line.length <= 76, `line of ${line.length} chars: ${line.slice(0, 40)}…`);
  }
});

test("a non-ASCII subject is RFC 2047 encoded", () => {
  const eml = buildEml({
    from: "a@b.example",
    to: "c@d.example",
    subject: "Proposal for Café Ltd",
    bodyText: "hi",
    attachment: null,
  });
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
});

test("an ASCII subject is left alone", () => {
  const eml = buildEml({
    from: "a@b.example",
    to: "c@d.example",
    subject: "Proposal for Meridian Logistics",
    bodyText: "hi",
    attachment: null,
  });
  assert.match(eml, /Subject: Proposal for Meridian Logistics\r\n/);
});

test("an attachment produces a valid multipart message with wrapped base64", () => {
  const bytes = new Uint8Array(500).fill(0x41);
  const eml = buildEml({
    from: "a@b.example",
    to: "c@d.example",
    subject: "S",
    bodyText: "See attached.",
    attachment: { filename: "KOY-2026-0001-proposal.pdf", mime: "application/pdf", bytes },
  });

  const boundary = /boundary="([^"]+)"/.exec(eml)?.[1];
  assert.ok(boundary, "a multipart message needs a boundary");
  assert.match(eml, /Content-Type: multipart\/mixed/);
  assert.match(eml, /Content-Disposition: attachment; filename="KOY-2026-0001-proposal\.pdf"/);
  assert.match(eml, /Content-Transfer-Encoding: base64/);
  // Opening and closing delimiters must both be present.
  assert.ok(eml.includes(`--${boundary}\r\n`));
  assert.ok(eml.includes(`--${boundary}--`));

  // The base64 payload must round-trip.
  const parts = eml.split(`--${boundary}`);
  const attachmentPart = parts.find((p) => p.includes("base64"));
  const payload = attachmentPart?.split("\r\n\r\n")[1]?.split(`\r\n--`)[0] ?? "";
  const decoded = Buffer.from(payload.replace(/\r\n/g, ""), "base64");
  assert.equal(decoded.length, 500);
  assert.equal(decoded[0], 0x41);

  for (const line of payload.split("\r\n")) {
    assert.ok(line.length <= 76, `base64 line of ${line.length} chars`);
  }
});

// ------------------------------------------------- the link actually sent

/**
 * The bug these were written after finding.
 *
 * The deliver page is rendered before any client link exists, on purpose:
 * minting one as a side effect of opening a page would be a way around the
 * approval gate. The draft email therefore had to say something in the
 * link's place, and it said `https://host/p/… (issued on send)`.
 *
 * That string sat in an editable textarea, the browser posted it back on
 * send, and the server used the submitted body verbatim. So the first send
 * of any proposal would have emailed the client a URL they could not open,
 * while the real link was minted a few lines away and used only for the
 * webhook payload. It reads as a cosmetic placeholder and it was the
 * delivery path quietly failing.
 */

const LIVE = "https://koya.example/p/abc123token";

test("the placeholder is not mistakable for a URL", () => {
  // The whole failure was a placeholder shaped like a link, which is why
  // nobody looked at it twice.
  assert.ok(!LINK_PLACEHOLDER.includes("http"));
  assert.ok(!LINK_PLACEHOLDER.includes("/p/"));
});

test("the draft carries the placeholder until a link exists", () => {
  const { bodyText } = renderClientEmail({
    intake: COMPLETE_INTAKE,
    proposalLink: LINK_PLACEHOLDER,
  });
  assert.ok(bodyText.includes(LINK_PLACEHOLDER));
});

test("sending substitutes the real link into the drafted body", () => {
  const { bodyText } = renderClientEmail({
    intake: COMPLETE_INTAKE,
    proposalLink: LINK_PLACEHOLDER,
  });
  const sent = applyProposalLink(bodyText, LIVE);
  assert.ok(sent.includes(LIVE));
  assert.ok(!sent.includes(LINK_PLACEHOLDER), "no placeholder may survive into the email");
});

test("an edited body keeps the salesperson's words and still gets the link", () => {
  const edited = `Hi Amara,\n\nAdding a note after our call.\n\n${LINK_PLACEHOLDER}\n\nAda`;
  const sent = applyProposalLink(edited, LIVE);
  assert.ok(sent.includes("Adding a note after our call."));
  assert.ok(sent.includes(LIVE));
});

test("a body with the placeholder deleted still reaches the client with a link", () => {
  // Reachable by editing the draft. An email inviting somebody to read a
  // proposal, with no way to read it, is worse than an awkward one.
  const stripped = "Hi Amara,\n\nHere is the proposal we discussed.\n\nAda";
  const sent = applyProposalLink(stripped, LIVE);
  assert.ok(sent.includes(LIVE));
  assert.ok(sent.includes("Here is the proposal we discussed."));
});

test("a body that already has the live link is left exactly as it is", () => {
  const already = `Hi Amara,\n\n${LIVE}\n\nAda`;
  assert.equal(applyProposalLink(already, LIVE), already);
});

test("the placeholder appears more than once if it was pasted twice", () => {
  const twice = `${LINK_PLACEHOLDER} and again ${LINK_PLACEHOLDER}`;
  const sent = applyProposalLink(twice, LIVE);
  assert.equal(sent.split(LIVE).length - 1, 2);
});

/* --------------------------------------------- the generated opening line */

test("a supplied opener replaces the templated first line, and nothing else", () => {
  const sentence = "Your dispatch team is typing every delivery note twice.";
  const plain = renderClientEmail({ intake: COMPLETE_INTAKE, proposalLink: LINK });
  const withOpener = renderClientEmail({
    intake: COMPLETE_INTAKE,
    proposalLink: LINK,
    opener: sentence,
  });

  assert.ok(withOpener.bodyText.includes(sentence));
  assert.ok(!withOpener.bodyText.includes("written around what you told us on the call"));

  // The subject and every line below the opener are untouched. That is the
  // whole design: one sentence varies so the rest stays gate-checkable.
  //
  // Compared structurally rather than against quoted phrases. The body is
  // copy somebody will reword, and a test that names its sentences fails on
  // an edit that broke nothing - which is how a suite trains people to ignore
  // it. Swapping only line 3 and diffing the rest proves the real property.
  assert.equal(withOpener.subject, plain.subject);

  const plainLines = plain.bodyText.split("\n");
  const openerLines = withOpener.bodyText.split("\n");
  assert.equal(openerLines.length, plainLines.length, "the opener changed the shape of the email");
  for (let i = 0; i < plainLines.length; i += 1) {
    if (plainLines[i] === TEMPLATED_FIRST_LINE) {
      assert.equal(openerLines[i], sentence, "the opener did not land on the templated line");
      continue;
    }
    assert.equal(openerLines[i], plainLines[i], `line ${i + 1} changed and should not have`);
  }
});

test("an absent, empty or whitespace opener falls back to the template", () => {
  const base = renderClientEmail({ intake: COMPLETE_INTAKE, proposalLink: LINK }).bodyText;
  for (const opener of [undefined, null, "", "   ", "\n"]) {
    const out = renderClientEmail({ intake: COMPLETE_INTAKE, proposalLink: LINK, opener });
    assert.equal(out.bodyText, base, `opener ${JSON.stringify(opener)} changed the email`);
  }
});

test("the opener hash covers the fields the sentence is written from, and no others", () => {
  const base = openerHash(COMPLETE_INTAKE);

  // A changed problem statement must invalidate the sentence.
  assert.notEqual(
    base,
    openerHash({ ...COMPLETE_INTAKE, client_needs_summary: "Something else entirely." }),
  );
  // A changed price must NOT, because the sentence never mentions one and
  // regenerating for it would be paying to produce identical words.
  assert.equal(base, openerHash({ ...COMPLETE_INTAKE, estimated_pricing: "£99,000" }));
  assert.equal(base, openerHash({ ...COMPLETE_INTAKE, proposed_timeline: "40 weeks" }));
});

test("the fallback opener is the line every proposal used before this existed", () => {
  const body = renderClientEmail({ intake: COMPLETE_INTAKE, proposalLink: LINK }).bodyText;
  assert.ok(body.includes(FALLBACK_OPENER));
});

test("the acceptance gate keeps real generated openers and rejects the tells", () => {
  // The three sentences Haiku actually produced for the fixtures, kept
  // verbatim so a change to the gate that would have thrown them away fails
  // here rather than silently reverting every email to the template.
  const real = [
    "Your dispatch team is typing every delivery note twice each morning, and the mistakes are costing you credit notes with your larger customers.",
    "Nobody can answer what is outstanding at a site without half an hour in the spreadsheets, and your compliance reporting is running on memory.",
    "Referral letters arrive through multiple channels and manual triage is delaying urgent cases from reaching a clinician on the same day.",
  ];
  for (const sentence of real) {
    assert.equal(isAcceptableOpener(sentence), true, `rejected a good opener: ${sentence}`);
  }

  const bad: [string, string][] = [
    ["too short", "Hello there."],
    ["em dash", "Your team types every note twice \u2014 and the errors cost you."],
    ["a price the proposal owns", "Your dispatch team rekeys every note, and it is costing you £48,000 a year."],
    ["a percentage", "Manual triage is delaying 40% of urgent referrals past the same day."],
    ["performed enthusiasm", "We are incredibly excited to help your dispatch team stop rekeying every delivery note."],
    ["throat clearing", "Thank you for taking the time to walk us through your dispatch process last week."],
    ["rambling past the ceiling", "Your dispatch team is typing every single delivery note twice over into both the order system and the finance system every morning, which takes two people most of the morning and produces errors."],
  ];
  for (const [why, sentence] of bad) {
    assert.equal(isAcceptableOpener(sentence), false, `accepted a bad opener (${why}): ${sentence}`);
  }
});

/* ------------------------------------------- the sending address ---------- */

test("a consumer mailbox domain is recognised as unverifiable", () => {
  /**
   * WHY THIS TEST EXISTS. RESEND_FROM was set to a gmail.com address and every
   * send failed with the provider's own wording, at the moment of sending. The
   * configuration can never work: SPF and DKIM records for gmail.com can only
   * be published by Google, so no amount of waiting or retrying fixes it. It
   * is worth naming on the System page rather than discovering in front of a
   * client.
   */
  const cases: [string, string | null][] = [
    ["Koya Talent <someone@gmail.com>", "gmail.com"],
    ["someone@GMAIL.COM", "gmail.com"],
    ["Koya <a@outlook.com>", "outlook.com"],
    ["Koya <a@icloud.com>", "icloud.com"],
    // A domain you can actually hold records for, and Resend's sandbox sender.
    ["Koya Talent <proposals@koyatalent.com>", null],
    ["Koya Talent <onboarding@resend.dev>", null],
  ];

  for (const [from, expected] of cases) {
    process.env.RESEND_FROM = from;
    assert.equal(
      config.resendFromIsUnverifiable,
      expected,
      `${from} should report ${expected ?? "no problem"}`,
    );
  }
  delete process.env.RESEND_FROM;
});

test("a sandbox recipient refusal is recognised, and nothing else is", () => {
  /**
   * WHY THIS TEST EXISTS. Copying the approver on the client email broke
   * sending outright on a Resend account with no verified domain: the
   * sandbox permits only the account owner as a recipient, and the copy list
   * IS a recipient list, so a send addressed correctly to the client was
   * refused because of who was being kept informed. The client heard nothing
   * because a colleague could not be copied, which is the wrong way round.
   *
   * The retry that drops the copy is only correct for THIS error. Resend
   * returns validation_error for several unrelated problems, and a malformed
   * body or a bad key must still fail on the first attempt rather than being
   * retried into a different, equally wrong shape.
   */
  const refusals = [
    "You can only send testing emails to your own email address (someone@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.",
    "YOU CAN ONLY SEND TESTING EMAILS TO YOUR OWN EMAIL ADDRESS",
  ];
  for (const m of refusals) {
    assert.equal(isRecipientRefusal(m), true, `should be a recipient refusal: ${m.slice(0, 40)}`);
  }

  const others = [
    "The gmail.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
    "API key is invalid",
    "Missing required field: subject",
    "Rate limit exceeded",
  ];
  for (const m of others) {
    assert.equal(isRecipientRefusal(m), false, `should NOT trigger a retry: ${m.slice(0, 40)}`);
  }
});

test("a body already carrying a different link gets the live one appended, not swapped", () => {
  /**
   * WHY THIS MATTERS. The deliver page used to render a real, freshly minted
   * URL into the editable body. By send time that token had been revoked:
   * the raw value is stored only as a hash, so `ensureShareLink` cannot hand
   * an existing one back, the send path calls `rotateShareLink` instead, and
   * rotation revokes the previous link. The body therefore held a URL the
   * send itself had just killed.
   *
   * `applyProposalLink` behaves correctly here and cannot rescue it: a stale
   * link is not the placeholder, so there is nothing to substitute, and the
   * live link is appended rather than lost. The client then sees two URLs,
   * the dead one in the sentence that points at it. The fix is upstream - the
   * draft body carries the placeholder and nothing else - and this test pins
   * the behaviour that made the symptom, so the shape is documented rather
   * than rediscovered.
   */
  // A genuinely different token, as a revoked link would be. Not a prefix of
  // the live one: `applyProposalLink` tests with `includes`, so a stale link
  // that merely contained the live one would look like a successful
  // substitution and the test would prove nothing.
  const stale = "https://proposals.example/p/hzIPYIK1qNczz58o7BlgJ3fTS4ZeVhDJ";
  const body = `Hi Amara,\n\nHere is the proposal.\n\n${stale}\n\nAda`;
  const out = applyProposalLink(body, LINK);

  assert.ok(out.includes(stale), "the stale link is left where it was");
  assert.ok(out.includes(LINK), "the live link is added");
  assert.ok(out.trimEnd().endsWith(LINK), "and it lands at the end, which is the tell");
});

test("a body with the placeholder gets exactly one link, in the right place", () => {
  // The state the deliver page now always produces.
  const body = `Hi Amara,\n\nHere is the proposal.\n\n${LINK_PLACEHOLDER}\n\nAda`;
  const out = applyProposalLink(body, LINK);

  const occurrences = out.split(LINK).length - 1;
  assert.equal(occurrences, 1, "exactly one link");
  assert.ok(!out.includes(LINK_PLACEHOLDER), "the placeholder is consumed");
  assert.ok(!out.trimEnd().endsWith(LINK), "it sits in the body, not appended after the sign-off");
});
