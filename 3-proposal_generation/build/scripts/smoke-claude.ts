/**
 * The model integration, tested for real.
 *
 * Separate from `npm run test:e2e` because this one costs money and can be
 * rate-limited. Keeping them apart means the lifecycle suite runs on every
 * change for free, and this runs when the model path itself is what changed.
 *
 * It proves four things the free suite cannot:
 *
 *   1. A complete intake produces all seven sections, parseable, in order.
 *   2. PROMPT CACHING IS ACTUALLY WORKING. The second call must report
 *      non-zero cache_read_input_tokens. If it reports zero, something
 *      non-deterministic has crept into the cached prefix and every call is
 *      silently paying full input price for identical text — a bug with no
 *      symptom other than the bill.
 *   3. The grounding gate finds nothing in a genuine draft, i.e. it is not
 *      producing false positives that would train users to ignore it.
 *   4. A sparse intake produces [NEEDS INPUT: ...] markers rather than
 *      invented figures.
 *
 *   npm run smoke:claude              the complete fixture
 *   npm run smoke:claude -- --missing the sparse fixture
 *   npm run smoke:claude -- --keep    leave the proposal for inspection
 */
import { randomUUID } from "node:crypto";
import { closePool, query } from "../lib/db";
import { hashPassword, sha256Hex } from "../lib/crypto";
import { formatUsd } from "../lib/claude/models";
import { createProposal, addSource, getGaps, getSections } from "../lib/proposal/repo";
import { generateDraft, type GenerationEvent } from "../lib/proposal/service";
import { allowedTextFor, checkNumbers } from "../lib/gates/grounding";
import { AI_SECTION_KEYS } from "../lib/proposal/sections";
import { hasGapMarker } from "../lib/proposal/parse";
import { COMPLETE_INTAKE, MISSING_INTAKE, SOURCE_BRIEF, SOURCED_INTAKE } from "../fixtures/intakes";
import type { User } from "../lib/auth";

const RUN = randomUUID().slice(0, 8);
const KEEP = process.argv.includes("--keep");
const WHICH = process.argv.includes("--missing")
  ? "missing"
  : process.argv.includes("--sourced")
    ? "sourced"
    : "complete";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n\n" +
        "This script makes real Claude calls, so it needs a key. Put it in\n" +
        "build/.env.local — see build/.env.example.\n\n" +
        "The free lifecycle suite (npm run test:e2e) needs no key and covers\n" +
        "everything except the model calls themselves.",
    );
    process.exitCode = 1;
    return;
  }

  const fixture =
    WHICH === "missing" ? MISSING_INTAKE : WHICH === "sourced" ? SOURCED_INTAKE : COMPLETE_INTAKE;

  console.log(`Claude smoke test — "${WHICH}" fixture\nrun ${RUN}\n`);

  const password = await hashPassword(`smoke-${RUN}-password`);
  const users = await query<{ id: string }>(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, 'salesperson', $3) RETURNING id`,
    [`smoke-${RUN}@example.invalid`, `Smoke ${RUN}`, password],
  );
  const actor: User = {
    id: users[0]!.id,
    email: `smoke-${RUN}@example.invalid`,
    name: `Smoke ${RUN}`,
    role: "salesperson",
    is_active: true,
  };

  const { proposal } = await createProposal({
    authorId: actor.id,
    intake: fixture,
    idempotencyKey: `smoke:${RUN}`,
  });
  console.log(`Proposal ${proposal.ref}  ${proposal.id}\n`);

  const sources: { filename: string; text: string }[] = [];
  if (WHICH === "sourced") {
    await addSource({
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
    sources.push({ filename: "northgate-background-notes.txt", text: SOURCE_BRIEF });
  }

  // ------------------------------------------------------- first generation
  console.log("First generation (streamed)");
  const seen: GenerationEvent["type"][] = [];
  let deltaCount = 0;
  let firstCost = 0;
  const started = Date.now();

  await generateDraft({
    proposalId: proposal.id,
    actor,
    correlationId: `smoke1-${RUN}`,
    onEvent: (event) => {
      if (!seen.includes(event.type)) seen.push(event.type);
      if (event.type === "delta") deltaCount += 1;
      if (event.type === "section_done") process.stdout.write(".");
      if (event.type === "done") firstCost = event.costMicroUsd;
      if (event.type === "error") console.log(`\n  error event: ${event.message}`);
    },
  });
  console.log(`\n  ${Math.round((Date.now() - started) / 1000)}s, ${deltaCount} deltas`);

  check("the stream emitted text deltas", deltaCount > 50, `${deltaCount}`);
  check("a done event arrived", seen.includes("done"));
  check("no error event", !seen.includes("error"));

  const sections = await getSections(proposal.id);
  const written = sections.filter((s) => s.body_md.trim().length > 0);
  check("all seven sections written", written.length === 7, `${written.length}`);

  for (const key of AI_SECTION_KEYS) {
    const body = sections.find((s) => s.key === key)?.body_md ?? "";
    check(`${key} has substantive prose`, body.trim().split(/\s+/).length >= 30, `${body.trim().split(/\s+/).length} words`);
  }

  const noMarkerLeak = sections.every(
    (s) => !s.body_md.includes("<<<SECTION") && !s.body_md.includes(">>>"),
  );
  check("no section delimiter leaked into a body", noMarkerLeak);

  // ------------------------------------------------------- prompt caching
  console.log("\nSecond generation (forced — proves prompt caching)");
  await generateDraft({
    proposalId: proposal.id,
    actor,
    correlationId: `smoke2-${RUN}`,
    force: true,
    onEvent: () => {},
  });

  const calls = await query<{
    purpose: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    cost_micro_usd: string;
    latency_ms: number | null;
    attempts: number;
    cache_hit: boolean;
    error_code: string | null;
  }>(
    `SELECT purpose, model, input_tokens, output_tokens, cache_creation_tokens,
            cache_read_tokens, cost_micro_usd, latency_ms, attempts, cache_hit, error_code
       FROM ai_calls WHERE proposal_id = $1 ORDER BY created_at`,
    [proposal.id],
  );

  console.log("\n  purpose            model              in     out  cached  ms     cost");
  for (const c of calls) {
    console.log(
      `  ${c.purpose.padEnd(18)} ${c.model.padEnd(18)} ${String(c.input_tokens).padStart(5)} ${String(c.output_tokens).padStart(7)} ${String(c.cache_read_tokens).padStart(7)} ${String(c.latency_ms ?? 0).padStart(6)} ${formatUsd(Number(c.cost_micro_usd)).padStart(9)}${c.error_code ? `  ERR ${c.error_code}` : ""}`,
    );
  }

  const drafts = calls.filter((c) => c.purpose === "draft" && !c.cache_hit);
  check("both draft calls were recorded", drafts.length >= 2, `${drafts.length}`);

  const secondDraft = drafts[drafts.length - 1];
  check(
    "the second draft read from the prompt cache",
    (secondDraft?.cache_read_tokens ?? 0) > 0,
    `cache_read_tokens = ${secondDraft?.cache_read_tokens ?? 0}. Zero means a non-deterministic value has entered the cached prefix.`,
  );

  const gateCalls = calls.filter(
    (c) => c.purpose === "gap_analysis" || c.purpose === "grounding_judge",
  );
  check("the gate calls ran on Haiku", gateCalls.every((c) => c.model === "claude-haiku-4-5"));
  check("the draft ran on Opus", drafts.every((c) => c.model === "claude-opus-5"));

  const totalCost = calls.reduce((sum, c) => sum + Number(c.cost_micro_usd), 0);
  console.log(`\n  total for two full drafts: ${formatUsd(totalCost)}`);
  console.log(`  first draft alone:         ${formatUsd(firstCost)}`);

  // --------------------------------------------------------- gate behaviour
  console.log("\nGates");
  const allowed = allowedTextFor(fixture, sources);
  const numeric = checkNumbers(
    sections.map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );
  if (numeric.length > 0) {
    for (const f of numeric) console.log(`    · ${f.sectionKey}: ${f.message}`);
  }

  const gaps = await getGaps(proposal.id);
  const blocking = gaps.filter((g) => g.status === "open" && g.severity === "blocking");

  if (WHICH === "complete" || WHICH === "sourced") {
    check(
      "a complete intake yields no invented figures",
      numeric.length === 0,
      `${numeric.length} findings`,
    );
    check("no blocking gaps on a complete intake", blocking.length === 0, `${blocking.length}`);
  } else {
    const marked = sections.some((s) => hasGapMarker(s.body_md));
    check("the sparse intake produced clarification markers, not invented facts", marked);
    check("those markers block approval", blocking.length > 0, `${blocking.length}`);
    console.log("\n  Markers Claude wrote:");
    for (const g of blocking.filter((x) => x.detected_by === "model")) {
      console.log(`    · ${g.message}`);
    }
  }

  if (WHICH === "sourced") {
    // The brief names Medibase PAS and an on-premises constraint; the intake
    // does not. A proposal that mentions either demonstrably used the file.
    const all = sections.map((s) => s.body_md).join("\n").toLowerCase();
    const usedSource =
      all.includes("medibase") ||
      all.includes("on-premise") ||
      all.includes("on premise") ||
      all.includes("your own infrastructure") ||
      all.includes("information governance") ||
      all.includes("clinical safety");
    check("the attached brief was actually used", usedSource);
    const cited = sections.some((s) => s.body_md.includes("[[source:"));
    check("the claim was cited to the document", cited);
  }

  // -------------------------------------------------------------- teardown
  if (!KEEP) {
    await query("DELETE FROM proposals WHERE id = $1", [proposal.id]);
    await query("DELETE FROM users WHERE id = $1", [actor.id]);
    console.log("\nCleaned up.");
  } else {
    console.log(`\nKept: /proposals/${proposal.id}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`\nSmoke test error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
