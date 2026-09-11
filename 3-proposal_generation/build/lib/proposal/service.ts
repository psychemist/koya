import { query, transaction } from "../db";
import { AppError, ErrorCode, errors } from "../errors";
import { recordAiCall, recordEvent } from "../audit";
import { streamClaude, callClaude } from "../claude/client";
import { PROMPT_VERSION, ROUTES, formatUsd } from "../claude/models";
import {
  deterministicNextSteps,
  draftUserMessage,
  intakeBlock,
  regenerateUserMessage,
  sourcesSystemBlock,
  stableSystemBlock,
  type SourceForPrompt,
} from "../claude/prompts";
import { analyseIntakeGaps } from "../gates/gaps";
import { allowedTextFor, checkNumbers, findingsToGaps, judgeClaims } from "../gates/grounding";
import { gapFingerprint, validateIntake, type GapCandidate, type Intake } from "./intake";
import { SectionStreamParser, extractCitationIndices, extractGaps } from "./parse";
import {
  AI_SECTION_KEYS,
  SECTION_BY_KEY,
  SECTIONS,
  type SectionKey,
} from "./sections";
import {
  countOpenBlockingGaps,
  generationHash,
  getProposalOrThrow,
  getSections,
  getSources,
  recordApproval,
  setContentHash,
  syncGaps,
  transitionStatus,
  writeSection,
  type ProposalRow,
  type SectionRow,
  type SourceRow,
} from "./repo";
import {
  assertCanApprove,
  assertCanWithdraw,
  assertTransition,
  isEditable,
  type Status,
} from "./state";
import { assertAccess } from "./access";
import { ensureEmailOpener } from "../delivery/opener";
import { checkStyle, type StyleFinding } from "../gates/style";
import type { Role, User } from "../auth";

/**
 * Orchestration: the sequence of steps that turns an intake into a reviewed
 * draft, and moves a draft through approval.
 *
 * The repository owns "how do I write this safely"; the state machine owns
 * "is this allowed"; this module owns "in what order, and what happens when a
 * step fails halfway".
 */

export type GenerationEvent =
  | { type: "status"; status: Status; message: string }
  | { type: "cache_hit"; message: string }
  | { type: "section_start"; key: SectionKey; heading: string }
  | { type: "delta"; key: SectionKey; text: string }
  | { type: "section_done"; key: SectionKey; body: string }
  | { type: "gates"; blocking: number; advisory: number; degraded: string[] }
  | { type: "done"; costMicroUsd: number; costLabel: string; sections: number }
  | { type: "error"; code: string; message: string; correlationId: string };

/** Sources shaped for the prompt, with the 1-based indices used in citations. */
function promptSources(sources: readonly SourceRow[]): SourceForPrompt[] {
  return sources
    .filter((s) => s.extract_status === "ok" && s.extracted_text.trim().length > 0)
    .map((s, i) => ({ index: i + 1, filename: s.filename, text: s.extracted_text }));
}

/**
 * The citation numbering, for anything that has to display it.
 *
 * `[[source:2]]` means "the second attachment the model was given", and only
 * this file knows which attachments those were: an upload that failed to
 * extract, or extracted to nothing, is never shown to the model and so never
 * takes a number. A renderer that recounted the list itself would drift the
 * moment one upload failed, and would then attribute a figure to the wrong
 * document, which is worse than printing the raw marker.
 */
export function citationTargets(
  sources: readonly SourceRow[],
): { index: number; id: string; filename: string }[] {
  const numbered = promptSources(sources);
  return numbered.flatMap((n) => {
    const row = sources.find((s) => s.filename === n.filename);
    return row ? [{ index: n.index, id: row.id, filename: row.filename }] : [];
  });
}

/**
 * The gap gate, run end to end.
 *
 * Deterministic validator first (free), then the model pass, then both are
 * reconciled into the `gaps` table under their own detector scopes so neither
 * closes the other's findings.
 */
export async function runGapAnalysis(args: {
  proposal: ProposalRow;
  correlationId: string;
  /** Skips the paid model pass. Used on every autosave. */
  cheapOnly?: boolean;
}): Promise<{ blocking: number; advisory: number; degraded: boolean }> {
  const intake = args.proposal.intake;

  const validatorGaps = validateIntake(intake);
  await syncGaps({
    proposalId: args.proposal.id,
    detectedBy: "validator",
    candidates: validatorGaps,
  });

  let degraded = false;
  if (!args.cheapOnly) {
    const analysis = await analyseIntakeGaps({
      intake,
      correlationId: args.correlationId,
      proposalId: args.proposal.id,
    });
    degraded = analysis.degraded;
    await syncGaps({
      proposalId: args.proposal.id,
      detectedBy: "model",
      candidates: analysis.gaps,
    });
  }

  const counts = await gapCounts(args.proposal.id);
  return { ...counts, degraded };
}

export async function gapCounts(
  proposalId: string,
): Promise<{ blocking: number; advisory: number }> {
  const rows = await query<{ severity: string; n: number }>(
    `SELECT severity, count(*)::int AS n FROM gaps
      WHERE proposal_id = $1 AND status = 'open' GROUP BY severity`,
    [proposalId],
  );
  return {
    blocking: rows.find((r) => r.severity === "blocking")?.n ?? 0,
    advisory: rows.find((r) => r.severity === "advisory")?.n ?? 0,
  };
}

/**
 * Writes the full draft.
 *
 * Emits events as it goes so the browser can render the proposal being
 * written. The steps are ordered so that a failure at any point leaves the
 * proposal in a state a human can act on:
 *
 *   1. Move to `generating`, guarded by version. Two clicks produce one run.
 *   2. Check the content hash. An unchanged intake with an existing draft is
 *      served from the database for nothing at all.
 *   3. Stream the model, rendering to the browser as it arrives but holding
 *      every database write until the response is known to be complete. A
 *      half-saved proposal is worse than none — the salesperson would have to
 *      work out for themselves which sections were real.
 *   4. Run the gates and reconcile gaps.
 *   5. Move to `review`.
 *
 * On any failure the proposal is returned to `draft` so it can be retried,
 * and the error is recorded with its correlation id.
 */
export async function generateDraft(args: {
  proposalId: string;
  actor: User;
  correlationId: string;
  force?: boolean;
  onEvent: (event: GenerationEvent) => void;
}): Promise<void> {
  const { onEvent, correlationId } = args;
  let proposal = await getProposalOrThrow(args.proposalId);

  assertAccess(proposal, args.actor, "edit");

  // `review` and `changes_requested` both allow a fresh full draft; the state
  // machine lists generating as reachable from each.
  assertTransition(proposal.status, "generating");
  proposal = await transitionStatus({
    proposalId: proposal.id,
    from: proposal.status,
    to: "generating",
    expectedVersion: proposal.version,
  });
  onEvent({ type: "status", status: "generating", message: "Writing the proposal…" });

  try {
    const sources = await getSources(proposal.id);
    const usable = promptSources(sources);
    const hash = generationHash({
      intake: proposal.intake,
      sourceTexts: usable.map((s) => s.text),
      promptVersion: PROMPT_VERSION,
      model: ROUTES.draft.model,
    });

    const existing = await getSections(proposal.id);
    const alreadyWritten = existing.filter((s) => s.body_md.trim().length > 0).length;

    // Step 2: the free path. Same inputs, same prompt, same model, and a draft
    // already on disk — so there is nothing to buy.
    if (!args.force && proposal.content_hash === hash && alreadyWritten >= SECTIONS.length) {
      await recordAiCall({
        proposalId: proposal.id,
        correlationId,
        purpose: "draft",
        model: ROUTES.draft.model,
        effort: ROUTES.draft.effort ?? null,
        promptVersion: PROMPT_VERSION,
        cacheHit: true,
        attempts: 0,
      });
      onEvent({
        type: "cache_hit",
        message:
          "Nothing has changed since the last draft, so it was reused and no tokens were spent. Use “Regenerate anyway” to force a rewrite.",
      });
      for (const s of existing) {
        onEvent({ type: "section_done", key: s.key, body: s.body_md });
      }
      const counts = await gapCounts(proposal.id);
      onEvent({ type: "gates", ...counts, degraded: [] });
      await transitionStatus({
        proposalId: proposal.id,
        from: "generating",
        to: "review",
        expectedVersion: proposal.version,
      });
      onEvent({ type: "done", costMicroUsd: 0, costLabel: "$0.00 (reused)", sections: existing.length });
      return;
    }

    // Step 3: stream.
    const system = [stableSystemBlock()];
    const sourcesBlock = sourcesSystemBlock(usable);
    if (sourcesBlock) system.push(sourcesBlock);

    // All of this state is local to the call. An earlier version kept the
    // parser's output queue at module scope, which would have interleaved the
    // sections of two proposals generating at the same time — the sort of bug
    // that never appears with one user and corrupts documents with two.
    const parser = new SectionStreamParser();
    const bodies = new Map<SectionKey, string>();
    const started = new Set<SectionKey>();

    // Synchronous on purpose. `onText` cannot await — a database write inside
    // the stream callback would stall the stream and risk the SDK's own
    // timeout — so this only touches memory and emits events, and every
    // database write happens after the stream has finished.
    const consume = (deltas: { key: SectionKey; delta: string }[]): void => {
      for (const d of deltas) {
        if (!started.has(d.key)) {
          started.add(d.key);
          onEvent({ type: "section_start", key: d.key, heading: SECTION_BY_KEY[d.key].heading });
        }
        bodies.set(d.key, (bodies.get(d.key) ?? "") + d.delta);
        onEvent({ type: "delta", key: d.key, text: d.delta });
      }
    };

    const result = await streamClaude({
      purpose: "draft",
      correlationId,
      proposalId: proposal.id,
      system,
      messages: [{ role: "user", content: draftUserMessage(proposal.intake) }],
      onText: (delta) => consume(parser.push(delta)),
    });
    consume(parser.end());

    // Structural validation BEFORE any write. A missing section means a
    // malformed response, and a half-saved proposal is worse than none: the
    // salesperson would have to work out which sections are real. Nothing is
    // persisted until the whole document is known to be well-formed.
    const missing = AI_SECTION_KEYS.filter((k) => (bodies.get(k) ?? "").trim().length === 0);
    if (missing.length > 0) {
      throw new AppError({
        code: ErrorCode.AI_MALFORMED_OUTPUT,
        userMessage: `Claude did not return ${missing.length === 1 ? "one section" : `${missing.length} sections`} (${missing.join(", ")}). Nothing was saved half-written. Try again.`,
        message: `missing sections: ${missing.join(",")}; unknown markers: ${parser.unknownMarkers.join(",")}`,
        detail: { missing, unknownMarkers: parser.unknownMarkers, preamble: parser.preamble.length },
        retryable: true,
      });
    }

    // Now that the response is known to be complete, write it.
    for (const key of AI_SECTION_KEYS) {
      const body = (bodies.get(key) ?? "").trim();
      await persistSection(proposal.id, key, body, args.actor.id);
      onEvent({ type: "section_done", key, body });
    }

    // Next Steps costs nothing: same close every time.
    const nextSteps = deterministicNextSteps(proposal.intake);
    await persistSection(proposal.id, "next_steps", nextSteps, args.actor.id);
    onEvent({ type: "section_done", key: "next_steps", body: nextSteps });

    // Step 4: gates.
    const written = await getSections(proposal.id);
    const degraded = await runAllGates({
      proposal,
      sections: written,
      sources,
      correlationId,
    });

    await setContentHash(proposal.id, hash);
    await recordCitations(proposal.id, written, sources);

    const counts = await gapCounts(proposal.id);
    onEvent({ type: "gates", ...counts, degraded });

    // Step 5.
    const fresh = await getProposalOrThrow(proposal.id);
    await transitionStatus({
      proposalId: proposal.id,
      from: "generating",
      to: "review",
      expectedVersion: fresh.version,
    });

    onEvent({
      type: "done",
      costMicroUsd: result.costMicroUsd,
      costLabel: formatUsd(result.costMicroUsd),
      sections: written.length,
    });
  } catch (err) {
    // Return the proposal to a state the user can retry from. Done on a fresh
    // read because the version has moved on since we started.
    try {
      const current = await getProposalOrThrow(proposal.id);
      if (current.status === "generating") {
        await transitionStatus({
          proposalId: proposal.id,
          from: "generating",
          to: "draft",
          expectedVersion: current.version,
        });
      }
    } catch {
      // If even the unwind fails, the original error is the one worth raising.
    }

    const app = err instanceof AppError ? err : null;
    await recordEvent({
      correlationId,
      action: "proposal.generate",
      outcome: "error",
      actorId: args.actor.id,
      proposalId: proposal.id,
      errorCode: app?.code ?? "INTERNAL",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });

    onEvent({
      type: "error",
      code: app?.code ?? "INTERNAL",
      message:
        app?.userMessage ??
        "Generation failed. Nothing was saved half-written, and your intake is untouched.",
      correlationId,
    });
    throw err;
  }
}

async function persistSection(
  proposalId: string,
  key: SectionKey,
  body: string,
  actorId: string,
): Promise<void> {
  await writeSection({
    proposalId,
    key,
    bodyMd: body.trim(),
    origin: "ai_draft",
    actorId,
  });
}

/** Runs both grounding passes and reconciles everything into `gaps`. */
async function runAllGates(args: {
  proposal: ProposalRow;
  sections: readonly SectionRow[];
  sources: readonly SourceRow[];
  correlationId: string;
}): Promise<string[]> {
  const degraded: string[] = [];

  // Marker-derived gaps: what the model itself said it was missing.
  const markerGaps: GapCandidate[] = [];
  for (const s of args.sections) {
    markerGaps.push(...extractGaps(s.key, s.body_md));
  }

  // Validator gaps, refreshed — the intake may have changed since last time.
  const validatorGaps = validateIntake(args.proposal.intake);

  await syncGaps({
    proposalId: args.proposal.id,
    detectedBy: "validator",
    candidates: validatorGaps,
  });
  await syncGaps({
    proposalId: args.proposal.id,
    detectedBy: "model",
    candidates: markerGaps,
  });

  const allowed = allowedTextFor(
    args.proposal.intake,
    promptSources(args.sources).map((s) => ({ filename: s.filename, text: s.text })),
  );

  const numeric = checkNumbers(
    args.sections.map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );

  const judged = await judgeClaims({
    sections: args.sections.map((s) => ({ key: s.key, heading: s.heading, body: s.body_md })),
    allowedText: allowed,
    correlationId: args.correlationId,
    proposalId: args.proposal.id,
  });
  if (judged.degraded) degraded.push("grounding judge");

  await syncGaps({
    proposalId: args.proposal.id,
    detectedBy: "grounding",
    candidates: findingsToGaps([...numeric, ...judged.findings]),
  });

  /**
   * The style gate. Free, deterministic, and advisory by design.
   *
   * Its own detector, for the same reason the upload scanner has one:
   * `syncGaps` closes every open gap from the detector it is given that is not
   * in the candidate list, so sharing `grounding` would mean a clean style
   * pass silently resolved the ungrounded-figure gaps.
   */
  await syncGaps({
    proposalId: args.proposal.id,
    detectedBy: "style",
    candidates: styleFindingsToGaps(checkStyle(
      args.sections.map((sec) => ({ key: sec.key, body: sec.body_md })),
    )),
  });

  return degraded;
}

/**
 * Style findings become advisory gaps.
 *
 * Never blocking. A style gate that stops a proposal over a word choice
 * teaches a salesperson to waive without reading, which costs more than the
 * word did.
 */
function styleFindingsToGaps(findings: readonly StyleFinding[]): GapCandidate[] {
  return findings.map((f) => {
    const sectionKey = f.sectionKey === "document" ? null : f.sectionKey;
    const message = `${f.message} (${f.evidence})`;
    return {
      sectionKey,
      field: null,
      severity: "advisory" as const,
      detectedBy: "style" as const,
      message,
      fingerprint: gapFingerprint({ sectionKey, field: null, message }),
    };
  });
}

/** Links `[[source:N]]` markers to actual source rows. */
async function recordCitations(
  proposalId: string,
  sections: readonly SectionRow[],
  sources: readonly SourceRow[],
): Promise<void> {
  const byIndex = new Map(promptSources(sources).map((s) => [s.index, s]));
  const indexToId = new Map<number, string>();
  for (const [index, ps] of byIndex) {
    const match = sources.find((s) => s.filename === ps.filename);
    if (match) indexToId.set(index, match.id);
  }

  await transaction(async (client) => {
    for (const section of sections) {
      await client.query("DELETE FROM citations WHERE section_id = $1", [section.id]);
      for (const index of extractCitationIndices(section.body_md)) {
        const sourceId = indexToId.get(index);
        if (!sourceId) continue;
        await client.query(
          "INSERT INTO citations (section_id, source_id, quote) VALUES ($1, $2, $3)",
          [section.id, sourceId, `[[source:${index}]]`],
        );
      }
    }
  });
}

/**
 * Rewrites one section.
 *
 * This is the operation the PRD singles out: it must not disturb the rest of
 * the proposal. It touches one row, appends one history entry, and re-runs the
 * gates over the whole document afterwards — because a rewritten pricing
 * section can introduce a figure that the rest of the document contradicts,
 * and checking only the section that changed would miss it.
 */
export async function regenerateSection(args: {
  proposalId: string;
  key: SectionKey;
  instruction?: string | null;
  actor: User;
  correlationId: string;
}): Promise<{ body: string; costMicroUsd: number; blocking: number; advisory: number }> {
  const proposal = await getProposalOrThrow(args.proposalId);
  assertAccess(proposal, args.actor, "edit");

  if (!isEditable(proposal.status)) {
    throw new AppError({
      code: ErrorCode.INVALID_TRANSITION,
      userMessage:
        proposal.status === "pending_approval"
          ? "This proposal is awaiting approval, so it is locked. Ask the approver to send it back for changes first."
          : `This proposal cannot be edited while it is ${proposal.status.replace("_", " ")}.`,
      detail: { status: proposal.status },
    });
  }

  const sections = await getSections(proposal.id);
  const target = sections.find((s) => s.key === args.key);
  if (!target) throw errors.notFound(`Section "${args.key}"`);

  const sources = await getSources(proposal.id);
  const usable = promptSources(sources);

  const system = [stableSystemBlock()];
  const sourcesBlock = sourcesSystemBlock(usable);
  if (sourcesBlock) system.push(sourcesBlock);

  const result = await callClaude({
    purpose: "section_regen",
    correlationId: args.correlationId,
    proposalId: proposal.id,
    system,
    messages: [
      {
        role: "user",
        content: regenerateUserMessage({
          intake: proposal.intake,
          sectionKey: args.key,
          currentBody: target.body_md,
          otherSections: sections
            .filter((s) => s.key !== args.key && s.body_md.trim().length > 0)
            .map((s) => ({ heading: s.heading, body: s.body_md })),
          instruction: args.instruction ?? null,
        }),
      },
    ],
  });

  const body = result.text.trim();
  if (body.length === 0) {
    throw new AppError({
      code: ErrorCode.AI_MALFORMED_OUTPUT,
      userMessage: "Claude returned an empty section, so nothing was changed. Try again.",
      message: "empty regeneration result",
      retryable: true,
    });
  }

  await writeSection({
    proposalId: proposal.id,
    key: args.key,
    bodyMd: body,
    origin: "ai_regeneration",
    actorId: args.actor.id,
    instruction: args.instruction ?? null,
    aiCallId: result.aiCallId,
  });

  const refreshed = await getSections(proposal.id);
  await runAllGates({ proposal, sections: refreshed, sources, correlationId: args.correlationId });
  await recordCitations(proposal.id, refreshed, sources);

  const counts = await gapCounts(proposal.id);
  return { body, costMicroUsd: result.costMicroUsd, ...counts };
}

/** A hand-written edit. No model call, so no cost and no gates on the model. */
export async function editSection(args: {
  proposalId: string;
  key: SectionKey;
  bodyMd: string;
  actor: User;
  correlationId: string;
}): Promise<{ blocking: number; advisory: number }> {
  const proposal = await getProposalOrThrow(args.proposalId);
  assertAccess(proposal, args.actor, "edit");
  if (!isEditable(proposal.status)) {
    throw errors.invalidTransition(proposal.status, "review");
  }

  await writeSection({
    proposalId: proposal.id,
    key: args.key,
    bodyMd: args.bodyMd.trim(),
    origin: "human_edit",
    actorId: args.actor.id,
    markEditedByHuman: true,
  });

  // The deterministic gate still runs on a human edit: a salesperson can paste
  // in a figure just as easily as a model can invent one, and the check is free.
  const sections = await getSections(proposal.id);
  const sources = await getSources(proposal.id);
  const allowed = allowedTextFor(
    proposal.intake,
    promptSources(sources).map((s) => ({ filename: s.filename, text: s.text })),
  );
  const numeric = checkNumbers(
    sections.map((s) => ({ key: s.key, body: s.body_md })),
    allowed,
  );
  const markerGaps: GapCandidate[] = [];
  for (const s of sections) markerGaps.push(...extractGaps(s.key, s.body_md));

  await syncGaps({
    proposalId: proposal.id,
    detectedBy: "grounding",
    candidates: findingsToGaps(numeric),
  });
  await syncGaps({ proposalId: proposal.id, detectedBy: "model", candidates: markerGaps });

  return gapCounts(proposal.id);
}

export async function revertSection(args: {
  proposalId: string;
  key: SectionKey;
  version: number;
  actor: User;
}): Promise<string> {
  const proposal = await getProposalOrThrow(args.proposalId);
  assertAccess(proposal, args.actor, "edit");
  if (!isEditable(proposal.status)) {
    throw errors.invalidTransition(proposal.status, "review");
  }

  const row = await query<{ body_md: string }>(
    `SELECT sv.body_md
       FROM section_versions sv
       JOIN proposal_sections ps ON ps.id = sv.section_id
      WHERE sv.proposal_id = $1 AND ps.key = $2 AND sv.version = $3`,
    [args.proposalId, args.key, args.version],
  );
  const body = row[0]?.body_md;
  if (body === undefined) throw errors.notFound("That version");

  await writeSection({
    proposalId: args.proposalId,
    key: args.key,
    bodyMd: body,
    origin: "revert",
    actorId: args.actor.id,
    instruction: `Reverted to version ${args.version}`,
  });

  return body;
}

// --------------------------------------------------------------- transitions

export async function submitForApproval(args: {
  proposalId: string;
  actor: User;
  correlationId: string;
}): Promise<ProposalRow> {
  const proposal = await getProposalOrThrow(args.proposalId);
  assertAccess(proposal, args.actor, "edit");
  assertTransition(proposal.status, "pending_approval");

  const unwritten = (await getSections(proposal.id)).filter(
    (s) => s.body_md.trim().length === 0,
  );
  if (unwritten.length > 0) {
    throw errors.validation(
      `${unwritten.length} section${unwritten.length === 1 ? " is" : "s are"} still empty (${unwritten.map((s) => s.heading).join(", ")}). Generate or write them before submitting.`,
      { unwritten: unwritten.map((s) => s.key) },
    );
  }

  return transitionStatus({
    proposalId: proposal.id,
    from: proposal.status,
    to: "pending_approval",
    expectedVersion: proposal.version,
  });
}

/**
 * The author takes their submission back.
 *
 * `assertAccess(..., "edit")` rather than a role check: "edit" is the
 * capability that means "this is your proposal", and it is already the rule
 * used by submit. An approver holds view and send but not edit, which is
 * exactly the distinction wanted here.
 */
export async function withdrawSubmission(args: {
  proposalId: string;
  actor: User;
  correlationId: string;
}): Promise<ProposalRow> {
  const proposal = await getProposalOrThrow(args.proposalId);
  // "view" rather than "edit": an approver may recall an approved proposal
  // and an approver deliberately holds no edit capability.
  assertAccess(proposal, args.actor, "view");
  assertCanWithdraw({
    status: proposal.status,
    actorId: args.actor.id,
    actorRole: args.actor.role as Role,
    authorId: proposal.author_id,
  });

  return transitionStatus({
    proposalId: proposal.id,
    from: proposal.status,
    to: "review",
    expectedVersion: proposal.version,
  });
}

export async function decideApproval(args: {
  proposalId: string;
  actor: User;
  decision: "approved" | "changes_requested";
  note?: string | null;
  correlationId: string;
}): Promise<ProposalRow> {
  const proposal = await getProposalOrThrow(args.proposalId);
  const openBlocking = await countOpenBlockingGaps(proposal.id);

  if (args.decision === "approved") {
    assertCanApprove({
      status: proposal.status,
      actorId: args.actor.id,
      actorRole: args.actor.role as Role,
      authorId: proposal.author_id,
      openBlockingGaps: openBlocking,
    });
  } else {
    if (args.actor.role !== "approver" && args.actor.role !== "admin") {
      throw errors.forbiddenRole("approver", args.actor.role);
    }
    if (proposal.status !== "pending_approval") {
      throw errors.invalidTransition(proposal.status, "changes_requested");
    }
    if (!args.note || args.note.trim().length < 5) {
      throw errors.validation(
        "Say what needs changing. A rejection with no note leaves the salesperson guessing.",
      );
    }
  }

  // The approval record and the status change are one transaction: an approval
  // logged against a proposal that did not move, or a proposal that moved with
  // no record of who moved it, would both make the audit trail a fiction.
  return transaction(async (client) => {
    const updated = await transitionStatus({
      proposalId: proposal.id,
      from: proposal.status,
      to: args.decision,
      expectedVersion: proposal.version,
      approverId: args.actor.id,
      client,
    });
    await recordApproval({
      proposalId: proposal.id,
      actorId: args.actor.id,
      decision: args.decision,
      note: args.note ?? null,
      client,
    });
    return updated;
  }).then(async (updated) => {
    /**
     * The covering email's opening sentence, generated here.
     *
     * Approval is the right moment and the only good one. It is a POST, which
     * matters: the deliver page is a GET, and a GET that spends money is the
     * thing this codebase refuses to do elsewhere — a proxy or a prefetcher
     * would bill for a page nobody read. It is also the point at which the
     * proposal becomes deliverable, so the sentence is always there by the
     * time anyone opens the deliver page.
     *
     * Outside the transaction, and after it. The approval and the status
     * change are the thing that must be atomic; a sentence for an email is
     * not, and holding a transaction open across a model call would be a
     * lock held for seconds on the row a whole team is waiting on.
     *
     * `ensureEmailOpener` never throws and falls back to the templated line,
     * so nothing here can fail an approval that has already committed.
     */
    if (args.decision === "approved") {
      await ensureEmailOpener({
        proposalId: proposal.id,
        intake: proposal.intake,
        correlationId: args.correlationId,
        actorId: args.actor.id,
      });
    }
    return updated;
  });
}

/**
 * Everything the workspace needs, in one round trip.
 *
 * `actor` is required rather than optional. An optional viewer argument is an
 * access check that any new call site can forget to pass, and a page that
 * forgets it renders somebody else's client pricing.
 */
/**
 * Whether the written sections still match the intake they were drafted from.
 *
 * `content_hash` is stamped on the proposal when a draft is generated, over
 * the intake, the source texts, the prompt version and the model. Recomputing
 * it costs nothing and answers the question directly: if it no longer matches
 * what is stored, something the prose was written from has changed since.
 *
 * WHY THIS IS SURFACED RATHER THAN ENFORCED. Correcting a client's name after
 * approval and before sending is a normal, sensible thing to do, and it does
 * not make the proposal wrong - it makes the greeting wrong in a document
 * nobody re-read. Blocking the send would punish the correction. Regenerating
 * automatically would be worse: it would spend Opus money and silently
 * replace prose an approver had signed off, which is the one thing the
 * approval step exists to prevent.
 *
 * So the person is told, at the two moments they can act on it: approving,
 * and sending.
 */
export async function draftIsStale(proposalId: string): Promise<boolean> {
  const proposal = await getProposalOrThrow(proposalId);
  // Never generated. Nothing to be stale against.
  if (!proposal.content_hash) return false;

  const sources = await getSources(proposalId);
  const current = generationHash({
    intake: proposal.intake,
    sourceTexts: promptSources(sources).map((x) => x.text),
    promptVersion: PROMPT_VERSION,
    model: ROUTES.draft.model,
  });
  return current !== proposal.content_hash;
}

export async function loadWorkspace(
  proposalId: string,
  actor: User,
): Promise<{
  proposal: ProposalRow;
  sections: SectionRow[];
  sources: SourceRow[];
}> {
  const [proposal, sections, sources] = await Promise.all([
    getProposalOrThrow(proposalId),
    getSections(proposalId),
    getSources(proposalId),
  ]);
  assertAccess(proposal, actor, "view");
  return { proposal, sections, sources };
}

export { intakeBlock };
