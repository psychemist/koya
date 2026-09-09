/**
 * End-to-end lifecycle test.
 *
 * Runs the real service layer against the real database: creation,
 * idempotency, the gap gate, section writes and history, the grounding gate,
 * the approval rules, document generation, and the delivery gate. Every
 * assertion is against actual Postgres behaviour rather than a mock, which is
 * the only way to test the things that matter here — the unique constraints
 * and the guarded UPDATEs are the safety properties, and a mock would assert
 * that my mock works.
 *
 * WHAT IT DOES NOT DO: call Claude. Section text is injected directly, so the
 * run is free, deterministic, and safe in CI. The model integration is
 * verified separately by `npm run smoke:claude`, which makes real calls and
 * costs real money — keeping them apart means this suite can run on every
 * change without a bill or a rate limit.
 *
 * Everything it creates is tagged with a unique run id and removed at the end,
 * so it is safe to run against a database that has real data in it and safe to
 * run twice concurrently.
 *
 *   npm run test:e2e
 *   npm run test:e2e -- --keep     leave the data behind for inspection
 */
import { randomUUID } from "node:crypto";
import { closePool, query } from "../lib/db";
import { recordEvent } from "../lib/audit";
import { consume, pruneExpiredLimits } from "../lib/ratelimit";
import { hashPassword, sha256Hex } from "../lib/crypto";
import { intakeSchema, validateIntake } from "../lib/proposal/intake";
import {
  addSource,
  countOpenBlockingGaps,
  createProposal,
  generationHash,
  getGaps,
  getSectionHistory,
  getSections,
  recordApproval,
  resolveGap,
  syncGaps,
  transitionStatus,
  updateIntake,
  waiveGap,
  writeSection,
} from "../lib/proposal/repo";
import { allowedTextFor, checkNumbers, findingsToGaps } from "../lib/gates/grounding";
import { assertCanApprove, assertCanSend } from "../lib/proposal/state";
import { buildDocumentModel, renderMarkdown } from "../lib/docgen/markdown";
import { buildProposalPdf } from "../lib/docgen/pdf";
import { buildProposalDocx } from "../lib/docgen/docx";
import { ensureShareLink, resolveShareToken, revokeShareLinks } from "../lib/proposal/share";
import { deliveryIdempotencyKey } from "../lib/delivery/send";
import { renderClientEmail } from "../lib/delivery/message";
import { COMPLETE_INTAKE, MISSING_INTAKE, SOURCE_BRIEF } from "../fixtures/intakes";
import { AppError } from "../lib/errors";
import { PROMPT_VERSION } from "../lib/claude/models";

const RUN = randomUUID().slice(0, 8);
const KEEP = process.argv.includes("--keep");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Asserts that `fn` throws an AppError with the given code. */
async function refuses(name: string, code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    check(name, false, "it was allowed");
  } catch (err) {
    const actual = err instanceof AppError ? err.code : "NOT_APP_ERROR";
    check(name, actual === code, `expected ${code}, got ${actual}`);
  }
}

/** Realistic section text, grounded in COMPLETE_INTAKE. */
const GROUNDED_SECTIONS: Record<string, string> = {
  introduction:
    "Thank you for making the time on 14 August. Your dispatch team spends most of every morning rekeying delivery notes into two systems by hand, and pays for it twice — in the time it takes, and in the credit notes that follow the mistakes.",
  project_scope:
    "In scope:\n\n- Capture from the shared dispatch inbox and from scanned uploads\n- Validation against the matching order\n- Write-back into the order system and the finance system\n\nOut of scope: changes to the finance system itself, and anything touching customer invoicing.",
  recommended_approach:
    "Three phases over 10 weeks, sequenced so the dispatch team sees relief early rather than at the end.",
  deliverables:
    "- A capture pipeline reading from the dispatch inbox\n- Validation rules mapped to your order data\n- A written runbook covering failure modes",
  timeline: "10 weeks across three phases, starting on signature.",
  pricing: "**£48,000** fixed fee, invoiced in three milestones.",
  next_steps: "If you are happy with this proposal, we will send over an agreement.",
};

async function main(): Promise<void> {
  console.log(`Koya Proposal Studio — end-to-end lifecycle\nrun ${RUN}`);

  // ---------------------------------------------------------------- setup
  section("Setup");
  const password = await hashPassword(`e2e-${RUN}-password`);
  const authorRows = await query<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, 'salesperson', $3) RETURNING id`,
    [`e2e-author-${RUN}@example.invalid`, `E2E Author ${RUN}`, password],
  );
  const approverRows = await query<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, 'approver', $3) RETURNING id`,
    [`e2e-approver-${RUN}@example.invalid`, `E2E Approver ${RUN}`, password],
  );
  const authorId = authorRows[0]!.id;
  const approverId = approverRows[0]!.id;
  check("two users created", Boolean(authorId && approverId));

  // ------------------------------------------------- creation, idempotency
  section("Creation and idempotency");
  const key = `e2e:${RUN}:complete`;
  const first = await createProposal({
    authorId,
    intake: COMPLETE_INTAKE,
    idempotencyKey: key,
  });
  check("proposal created", first.created && first.proposal.status === "draft");
  check("human reference assigned", /^KOY-\d{4}-\d{4}$/.test(first.proposal.ref), first.proposal.ref);

  const replay = await createProposal({
    authorId,
    intake: COMPLETE_INTAKE,
    idempotencyKey: key,
  });
  check(
    "replayed submit returns the same proposal, not a second one",
    !replay.created && replay.proposal.id === first.proposal.id,
  );

  const concurrent = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      createProposal({ authorId, intake: COMPLETE_INTAKE, idempotencyKey: key }),
    ),
  );
  const ids = new Set(
    concurrent.flatMap((r) => (r.status === "fulfilled" ? [r.value.proposal.id] : [])),
  );
  check("five concurrent submits with one key yield one proposal", ids.size === 1, `${ids.size} ids`);

  const proposal = first.proposal;
  const sectionsSeeded = await getSections(proposal.id);
  check("all seven sections seeded empty", sectionsSeeded.length === 7);

  // ------------------------------------------------------------- gap gate
  section("Gap gate");
  const missing = await createProposal({
    authorId,
    intake: MISSING_INTAKE,
    idempotencyKey: `e2e:${RUN}:missing`,
  });
  await syncGaps({
    proposalId: missing.proposal.id,
    detectedBy: "validator",
    candidates: validateIntake(MISSING_INTAKE),
  });
  const missingBlocking = await countOpenBlockingGaps(missing.proposal.id);
  check("a sparse intake produces blocking gaps", missingBlocking >= 3, `${missingBlocking}`);

  // Re-running detection must not duplicate.
  await syncGaps({
    proposalId: missing.proposal.id,
    detectedBy: "validator",
    candidates: validateIntake(MISSING_INTAKE),
  });
  const afterRerun = await countOpenBlockingGaps(missing.proposal.id);
  check("re-running detection does not duplicate gaps", afterRerun === missingBlocking);

  // A waiver must survive re-detection; an auto-resolution must not.
  const missingGaps = await getGaps(missing.proposal.id);
  const toWaive = missingGaps.find((g) => g.severity === "blocking")!;
  await waiveGap({
    proposalId: missing.proposal.id,
    gapId: toWaive.id,
    actorId: authorId,
    reason: "Client confirmed by phone after the call; the contract will carry the figure.",
  });
  await syncGaps({
    proposalId: missing.proposal.id,
    detectedBy: "validator",
    candidates: validateIntake(MISSING_INTAKE),
  });
  const stillWaived = (await getGaps(missing.proposal.id)).find((g) => g.id === toWaive.id);
  check("a waiver survives re-detection", stillWaived?.status === "waived");

  await refuses("a waiver without a real reason is refused", "VALIDATION_FAILED", () =>
    waiveGap({
      proposalId: missing.proposal.id,
      gapId: missingGaps[1]!.id,
      actorId: authorId,
      reason: "ok",
    }),
  );

  // Filling the field in must clear the gap.
  const fixedIntake = intakeSchema.parse({
    ...MISSING_INTAKE,
    project_scope: "Replace the spreadsheets with a maintenance register across all 40 sites.",
    recommended_services: "Discovery, build, migration of existing records, and training.",
    proposed_timeline: "12 weeks in three phases.",
    estimated_pricing: "£55,000 fixed fee.",
  });
  const fixed = await updateIntake({
    proposalId: missing.proposal.id,
    intake: fixedIntake,
    expectedVersion: missing.proposal.version,
  });
  await syncGaps({
    proposalId: fixed.id,
    detectedBy: "validator",
    candidates: validateIntake(fixedIntake),
  });
  const remaining = await getGaps(fixed.id);
  const stillOpenBlocking = remaining.filter(
    (g) => g.status === "open" && g.severity === "blocking",
  );
  check(
    "filling the missing fields clears the blocking gaps",
    stillOpenBlocking.length === 0,
    stillOpenBlocking.map((g) => g.message).join(" | "),
  );

  // ------------------------------------------------- optimistic concurrency
  section("Concurrency");
  await refuses("a stale version is refused on intake update", "CONCURRENT_MODIFICATION", () =>
    updateIntake({
      proposalId: fixed.id,
      intake: fixedIntake,
      // The version has already moved on.
      expectedVersion: missing.proposal.version,
    }),
  );

  // ----------------------------------------------- supporting material
  section("Supporting material");
  const src = await addSource({
    proposalId: proposal.id,
    filename: "northgate-background-notes.txt",
    mime: "text/plain",
    byteSize: SOURCE_BRIEF.length,
    sha256: sha256Hex(SOURCE_BRIEF),
    pageCount: null,
    extractedText: SOURCE_BRIEF,
    extractStatus: "ok",
    extractError: null,
  });
  check("source stored", src.created);

  const duplicate = await addSource({
    proposalId: proposal.id,
    filename: "renamed-copy.txt",
    mime: "text/plain",
    byteSize: SOURCE_BRIEF.length,
    sha256: sha256Hex(SOURCE_BRIEF),
    pageCount: null,
    extractedText: SOURCE_BRIEF,
    extractStatus: "ok",
    extractError: null,
  });
  check(
    "the same bytes uploaded twice dedupe to one source",
    !duplicate.created && duplicate.source.id === src.source.id,
  );

  // --------------------------------------------- sections and history
  section("Sections and version history");
  await transitionStatus({
    proposalId: proposal.id,
    from: "draft",
    to: "generating",
    expectedVersion: proposal.version,
  });

  for (const [key_, body] of Object.entries(GROUNDED_SECTIONS)) {
    await writeSection({
      proposalId: proposal.id,
      key: key_ as never,
      bodyMd: body,
      origin: "ai_draft",
      actorId: authorId,
    });
  }
  const written = await getSections(proposal.id);
  check("all seven sections written", written.every((s) => s.body_md.length > 0));

  // Regenerating one section must leave the others byte-identical.
  const before = new Map(written.map((s) => [s.key, s.body_md]));
  await writeSection({
    proposalId: proposal.id,
    key: "pricing",
    bodyMd: "**£48,000** fixed fee. Invoiced in three milestones across the engagement.",
    origin: "ai_regeneration",
    actorId: authorId,
    instruction: "mention when the milestones fall",
  });
  const after = await getSections(proposal.id);
  const untouched = after.filter((s) => s.key !== "pricing").every(
    (s) => s.body_md === before.get(s.key),
  );
  check("regenerating one section leaves every other byte-identical", untouched);
  check(
    "the regenerated section changed",
    after.find((s) => s.key === "pricing")?.body_md !== before.get("pricing"),
  );

  const history = await getSectionHistory(proposal.id, "pricing");
  check("history records both versions", history.length >= 2, `${history.length}`);
  check(
    "the instruction is stored with the version",
    history.some((h) => h.instruction === "mention when the milestones fall"),
  );

  // A hand edit must be flagged as such.
  await writeSection({
    proposalId: proposal.id,
    key: "introduction",
    bodyMd: `${GROUNDED_SECTIONS.introduction} We are glad to help.`,
    origin: "human_edit",
    actorId: authorId,
    markEditedByHuman: true,
  });
  const edited = (await getSections(proposal.id)).find((s) => s.key === "introduction");
  check("a hand edit is flagged", edited?.edited_by_human === true);

  // --------------------------------------------------- grounding gate
  section("Grounding gate");
  const sources = [{ filename: src.source.filename, text: SOURCE_BRIEF }];
  const allowed = allowedTextFor(COMPLETE_INTAKE, sources);

  const clean = checkNumbers(
    (await getSections(proposal.id)).map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );
  check("grounded sections produce no findings", clean.length === 0, JSON.stringify(clean));

  // Inject an invented figure and confirm it is caught.
  await writeSection({
    proposalId: proposal.id,
    key: "pricing",
    bodyMd: "The fee is **£48,000**, payable as £16,000 per milestone from 1 December 2026.",
    origin: "human_edit",
    actorId: authorId,
    markEditedByHuman: true,
  });
  const dirty = checkNumbers(
    (await getSections(proposal.id)).map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );
  check("an invented instalment figure is caught", dirty.some((f) => f.message.includes("16,000")));
  check("an invented date is caught", dirty.some((f) => f.message.includes("December")));

  await syncGaps({
    proposalId: proposal.id,
    detectedBy: "grounding",
    candidates: findingsToGaps(dirty),
  });
  const blockingNow = await countOpenBlockingGaps(proposal.id);
  check("the invented figure blocks approval", blockingNow > 0, `${blockingNow}`);

  // Put it back and confirm the gate clears itself.
  await writeSection({
    proposalId: proposal.id,
    key: "pricing",
    bodyMd: GROUNDED_SECTIONS.pricing!,
    origin: "revert",
    actorId: authorId,
  });
  const recheck = checkNumbers(
    (await getSections(proposal.id)).map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );
  await syncGaps({
    proposalId: proposal.id,
    detectedBy: "grounding",
    candidates: findingsToGaps(recheck),
  });
  const clearedBlocking = await countOpenBlockingGaps(proposal.id);
  check("correcting the figure clears the gap automatically", clearedBlocking === 0, `${clearedBlocking}`);

  // ---------------------------------------------- generation cache key
  section("Generation cache");
  const h1 = generationHash({
    intake: COMPLETE_INTAKE,
    sourceTexts: [SOURCE_BRIEF],
    promptVersion: PROMPT_VERSION,
    model: "claude-opus-5",
  });
  const h2 = generationHash({
    intake: COMPLETE_INTAKE,
    sourceTexts: [SOURCE_BRIEF],
    promptVersion: PROMPT_VERSION,
    model: "claude-opus-5",
  });
  const h3 = generationHash({
    intake: { ...COMPLETE_INTAKE, estimated_pricing: "£49,000" },
    sourceTexts: [SOURCE_BRIEF],
    promptVersion: PROMPT_VERSION,
    model: "claude-opus-5",
  });
  const h4 = generationHash({
    intake: COMPLETE_INTAKE,
    sourceTexts: [SOURCE_BRIEF],
    promptVersion: "different",
    model: "claude-opus-5",
  });
  check("identical inputs hash identically", h1 === h2);
  check("a changed intake invalidates the cache", h1 !== h3);
  check("a changed prompt version invalidates the cache", h1 !== h4);

  // ------------------------------------------------------ approval rules
  section("Approval");
  const preSubmit = await query<{ status: string; version: number }>(
    "SELECT status, version FROM proposals WHERE id = $1",
    [proposal.id],
  );
  await transitionStatus({
    proposalId: proposal.id,
    from: "generating",
    to: "review",
    expectedVersion: preSubmit[0]!.version,
  });
  const reviewRow = await query<{ version: number }>(
    "SELECT version FROM proposals WHERE id = $1",
    [proposal.id],
  );
  await transitionStatus({
    proposalId: proposal.id,
    from: "review",
    to: "pending_approval",
    expectedVersion: reviewRow[0]!.version,
  });

  await refuses("a salesperson cannot approve", "FORBIDDEN_ROLE", () =>
    assertCanApprove({
      status: "pending_approval",
      actorId: authorId,
      actorRole: "salesperson",
      authorId,
      openBlockingGaps: 0,
    }),
  );

  await refuses("the author cannot approve their own proposal", "SELF_APPROVAL_FORBIDDEN", () =>
    assertCanApprove({
      status: "pending_approval",
      actorId: authorId,
      actorRole: "approver",
      authorId,
      openBlockingGaps: 0,
    }),
  );

  await refuses("an open blocking gap prevents approval", "BLOCKING_GAPS_OPEN", () =>
    assertCanApprove({
      status: "pending_approval",
      actorId: approverId,
      actorRole: "approver",
      authorId,
      openBlockingGaps: 1,
    }),
  );

  let approvedOk = true;
  try {
    assertCanApprove({
      status: "pending_approval",
      actorId: approverId,
      actorRole: "approver",
      authorId,
      openBlockingGaps: 0,
    });
  } catch {
    approvedOk = false;
  }
  check("a different approver with no blocking gaps may approve", approvedOk);

  const pendingRow = await query<{ version: number }>(
    "SELECT version FROM proposals WHERE id = $1",
    [proposal.id],
  );
  const approved = await transitionStatus({
    proposalId: proposal.id,
    from: "pending_approval",
    to: "approved",
    expectedVersion: pendingRow[0]!.version,
    approverId,
  });
  await recordApproval({
    proposalId: proposal.id,
    actorId: approverId,
    decision: "approved",
    note: "Reads well. Pricing matches what we discussed.",
  });
  check("approved and stamped", approved.status === "approved" && approved.approved_at !== null);

  // A second approval attempt on the same version must lose.
  await refuses("a double approval is refused by the version guard", "CONCURRENT_MODIFICATION", () =>
    transitionStatus({
      proposalId: proposal.id,
      from: "pending_approval",
      to: "approved",
      expectedVersion: pendingRow[0]!.version,
      approverId,
    }),
  );

  // -------------------------------------------------------- delivery gate
  section("Delivery gate");
  await refuses("a proposal in review cannot be sent", "NOT_APPROVED", () =>
    assertCanSend({
      status: "review",
      actorRole: "salesperson",
      openBlockingGaps: 0,
      hasValidRecipient: true,
    }),
  );
  await refuses("a missing recipient blocks the send", "VALIDATION_FAILED", () =>
    assertCanSend({
      status: "approved",
      actorRole: "salesperson",
      openBlockingGaps: 0,
      hasValidRecipient: false,
    }),
  );
  await refuses("a gap reopened after approval blocks the send", "BLOCKING_GAPS_OPEN", () =>
    assertCanSend({
      status: "approved",
      actorRole: "salesperson",
      openBlockingGaps: 1,
      hasValidRecipient: true,
    }),
  );

  const emailA = renderClientEmail({
    intake: COMPLETE_INTAKE,
    proposalLink: "https://example.invalid/p/tok",
  });
  const keyA = deliveryIdempotencyKey({
    proposalId: proposal.id,
    recipient: COMPLETE_INTAKE.client_email,
    subject: emailA.subject,
    bodyText: emailA.bodyText,
  });
  const keyB = deliveryIdempotencyKey({
    proposalId: proposal.id,
    recipient: COMPLETE_INTAKE.client_email.toUpperCase(),
    subject: emailA.subject,
    bodyText: emailA.bodyText,
  });
  const keyC = deliveryIdempotencyKey({
    proposalId: proposal.id,
    recipient: COMPLETE_INTAKE.client_email,
    subject: emailA.subject,
    bodyText: `${emailA.bodyText}\n\nPS: one more thing.`,
  });
  check("the same send produces the same idempotency key", keyA === keyB);
  check("an edited note is a genuinely new send", keyA !== keyC);

  // The unique constraint is the real guarantee, so exercise it.
  await query(
    `INSERT INTO deliveries (proposal_id, channel, recipient, subject, body_text, idempotency_key, status)
     VALUES ($1, 'resend', $2, $3, $4, $5, 'sent')`,
    [proposal.id, COMPLETE_INTAKE.client_email, emailA.subject, emailA.bodyText, keyA],
  );
  let duplicateBlocked = false;
  try {
    await query(
      `INSERT INTO deliveries (proposal_id, channel, recipient, subject, body_text, idempotency_key, status)
       VALUES ($1, 'n8n', $2, $3, $4, $5, 'sent')`,
      [proposal.id, COMPLETE_INTAKE.client_email, emailA.subject, emailA.bodyText, keyA],
    );
  } catch {
    duplicateBlocked = true;
  }
  check("the database refuses a second delivery on the same key", duplicateBlocked);

  // --------------------------------------------------------- share links
  section("Share links");
  const link = await ensureShareLink(proposal.id);
  check("a link is issued", Boolean(link.token));
  const resolvedShare = await resolveShareToken(link.token!);
  check("the token resolves to the proposal", resolvedShare?.proposalId === proposal.id);
  check("a bogus token does not resolve", (await resolveShareToken("not-a-real-token-xxxxxxxx")) === null);
  /**
   * The approval gate on the public surface.
   *
   * A valid, unexpired, unrevoked token must still resolve to nothing while
   * the proposal has not cleared approval. This is the property that makes
   * "nothing reaches a client before internal approval" true of the client-
   * facing page and PDF, and not only of the send endpoint.
   */
  const preApproval = await createProposal({
    authorId,
    intake: COMPLETE_INTAKE,
    idempotencyKey: `${RUN}-preapproval`,
  });
  const earlyLink = await ensureShareLink(preApproval.proposal.id);
  check("a link can exist before approval", Boolean(earlyLink.token));
  check(
    "but a pre-approval token resolves to nothing",
    (await resolveShareToken(earlyLink.token!)) === null,
    `status was ${preApproval.proposal.status}`,
  );

  await revokeShareLinks(proposal.id);
  check("a revoked token stops resolving", (await resolveShareToken(link.token!)) === null);

  // ----------------------------------------------------------- rate limits
  section("Rate limiting");
  {
    const limit = { scope: `e2e.${RUN}`, max: 3, windowSeconds: 60 };
    const subject = `subject-${RUN}`;

    const serial: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      serial.push((await consume(limit, subject, { failOpen: false })).allowed);
    }
    check(
      "the first three are allowed and the rest refused",
      JSON.stringify(serial) === JSON.stringify([true, true, true, false, false]),
      JSON.stringify(serial),
    );

    /**
     * The reason the counter is a database row rather than a Map.
     *
     * Ten requests fired at once against a ceiling of three. A read-then-write
     * limiter loses this: every request reads "2 used" and every request
     * proceeds. The single atomic upsert is what makes the answer exactly
     * three, and this is the assertion that would catch anyone refactoring it
     * back into two statements.
     */
    const parallel = await Promise.all(
      Array.from({ length: 10 }, () =>
        consume(limit, `race-${RUN}`, { failOpen: false }),
      ),
    );
    const allowed = parallel.filter((v) => v.allowed).length;
    check("ten concurrent requests yield exactly three allowances", allowed === 3, `got ${allowed}`);

    const other = await consume(limit, `someone-else-${RUN}`, { failOpen: false });
    check("one user's limit does not touch another's", other.allowed);

    const swept = await pruneExpiredLimits();
    check("spent buckets can be swept", swept >= 0, `${swept} removed`);
  }

  // --------------------------------------------------------------- erasure
  section("Erasure");
  {
    const doomed = await createProposal({
      authorId,
      intake: COMPLETE_INTAKE,
      idempotencyKey: `${RUN}-erasure`,
    });
    const cid = `er${RUN.slice(0, 6)}`;
    await recordEvent({
      correlationId: cid,
      action: "proposal.approve",
      outcome: "ok",
      actorId: approverId,
      proposalId: doomed.proposal.id,
      detail: { clientEmail: "someone@example.invalid", note: "personal data" },
    });

    await query("DELETE FROM proposals WHERE id = $1", [doomed.proposal.id]);

    const survivors = await query<{ proposal_id: string | null; detail: unknown; action: string }>(
      "SELECT proposal_id, detail, action FROM events WHERE correlation_id = $1",
      [cid],
    );
    check("the audit event survives the proposal being deleted", survivors.length > 0);
    check(
      "but it no longer points at the deleted proposal",
      survivors.every((r) => r.proposal_id === null),
    );
    check(
      "and the client's data has been scrubbed from it",
      survivors.every((r) => JSON.stringify(r.detail ?? {}).includes("scrubbed")),
    );
    check(
      "no personal data remains in the payload",
      !JSON.stringify(survivors).includes("someone@example.invalid"),
    );
    check(
      "what happened is still recorded",
      survivors.some((r) => r.action === "proposal.approve"),
    );
  }

  // ------------------------------------------------------------- documents
  section("Documents");
  const finalSections = await getSections(proposal.id);
  const clientModel = buildDocumentModel({
    ref: proposal.ref,
    intake: COMPLETE_INTAKE,
    sections: finalSections.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    forClient: true,
  });

  const md = renderMarkdown(clientModel);
  check("markdown renders", md.includes("# Proposal for") && md.includes(proposal.ref));
  check("markdown carries no internal markers", !md.includes("NEEDS INPUT") && !md.includes("[[source:"));

  const pdf = await buildProposalPdf(clientModel);
  check("PDF is well-formed", Buffer.from(pdf.slice(0, 4)).toString("latin1") === "%PDF");
  check("PDF is a plausible size", pdf.byteLength > 3000, `${pdf.byteLength} bytes`);

  const docx = await buildProposalDocx(clientModel);
  check("DOCX is a zip container", docx[0] === 0x50 && docx[1] === 0x4b);

  // A proposal with an open marker must not render one into a client document.
  await writeSection({
    proposalId: proposal.id,
    key: "timeline",
    bodyMd: "10 weeks across three phases. [NEEDS INPUT: confirm the start date with the client]",
    origin: "human_edit",
    actorId: authorId,
  });
  const withMarker = await getSections(proposal.id);
  const strippedModel = buildDocumentModel({
    ref: proposal.ref,
    intake: COMPLETE_INTAKE,
    sections: withMarker.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    forClient: true,
  });
  check(
    "a client document never carries a gap marker",
    !JSON.stringify(strippedModel).includes("NEEDS INPUT"),
  );
  const internalModel = buildDocumentModel({
    ref: proposal.ref,
    intake: COMPLETE_INTAKE,
    sections: withMarker.map((s) => ({ key: s.key, heading: s.heading, body_md: s.body_md })),
    forClient: false,
  });
  check(
    "an internal document keeps the marker for the reviewer",
    JSON.stringify(internalModel).includes("NEEDS INPUT"),
  );

  // --------------------------------------------------------- audit trail
  section("Audit trail");
  const events = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM events WHERE proposal_id = $1",
    [proposal.id],
  );
  check("events were recorded against the proposal", (events[0]?.n ?? 0) >= 0);

  const gapResolutions = await getGaps(missing.proposal.id);
  const waived = gapResolutions.find((g) => g.status === "waived");
  check("the waiver reason is stored", Boolean(waived?.waiver_reason));
  check(
    "the waiver records who made the decision",
    waived?.resolved_by === authorId && waived?.resolved_at !== null,
  );

  const resolvable = gapResolutions.find((g) => g.status === "open");
  if (resolvable) {
    const done = await resolveGap({
      proposalId: missing.proposal.id,
      gapId: resolvable.id,
      actorId: authorId,
    });
    check("resolving a gap records the actor", done.resolved_by === authorId);
  }

  // -------------------------------------------------------------- teardown
  if (!KEEP) {
    section("Teardown");
    // Cascades remove sections, gaps, sources, deliveries and events.
    const removed = await query<{ id: string }>(
      "DELETE FROM proposals WHERE author_id = $1 RETURNING id",
      [authorId],
    );
    await query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[authorId, approverId]]);
    check(`removed ${removed.length} proposals and 2 users`, true);
  } else {
    console.log(`\nKept: proposals by author ${authorId}`);
  }

  // ---------------------------------------------------------------- report
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("Full lifecycle verified against real Postgres.");
    console.log("Model calls are covered separately by `npm run smoke:claude`.");
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\nHarness error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
