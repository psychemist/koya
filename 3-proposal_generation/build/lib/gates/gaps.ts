import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { parseClaude } from "../claude/client";
import { intakeBlock } from "../claude/prompts";
import {
  gapFingerprint,
  INTAKE_FIELDS,
  validateIntake,
  type GapCandidate,
  type Intake,
  type IntakeField,
} from "../proposal/intake";
import { isSectionKey } from "../proposal/sections";

/**
 * The gap gate, second pass.
 *
 * The deterministic validator in intake.ts has already run and found
 * everything a rule can find: empty fields, placeholders, prices without
 * figures, unreadable dates. Those cost nothing and are already known.
 *
 * This pass asks the one question rules cannot: is what IS here actually
 * enough, and is it coherent? A scope that describes a mobile app while the
 * recommended services list only workshops; a timeline of two weeks against a
 * scope that plainly needs three months; a needs summary that names a problem
 * the scope never addresses. Each of those is a full set of fields that a
 * validator passes and a proposal should not be written from.
 *
 * The validator's findings are sent along so the model can be told, explicitly,
 * not to repeat them — otherwise most of its output is duplicates and the
 * salesperson sees the same gap twice with different wording.
 */

const analysisSchema = z.object({
  gaps: z
    .array(
      z.object({
        field: z
          .string()
          .describe(
            `The intake field this concerns, one of: ${INTAKE_FIELDS.join(", ")}. Use "none" if it spans several.`,
          ),
        section: z
          .string()
          .describe(
            "The proposal section this would damage, or \"none\". One of: introduction, project_scope, recommended_approach, deliverables, timeline, pricing, next_steps.",
          ),
        severity: z
          .enum(["blocking", "advisory"])
          .describe(
            "advisory in almost every case. Use blocking ONLY for a direct contradiction between two answers that cannot both be true, because a blocking gap stops the proposal being approved at all.",
          ),
        question: z
          .string()
          .describe(
            "The specific question to put to the salesperson, answerable in one line. The actual question, not a description of the problem.",
          ),
      }),
    )
    .describe("Problems with the intake. Empty array when it is coherent and sufficient."),
});

type Analysis = z.infer<typeof analysisSchema>;

const GAP_SYSTEM = `You review a sales intake form before a proposal is written from it. You are looking for one thing: places where writing the proposal would force the writer to invent something, or where the answers contradict each other.

Report:
- internal contradictions (a scope that needs months against a timeline of days; services that do not address the stated need; pricing that does not match the scale of the work described)
- answers that are present but too vague to write a specific sentence from ("improve their processes", "the usual package")
- a stated need with no corresponding service, or a service that addresses nothing that was asked for
- missing commercial terms a client will ask about immediately, where the intake implies they should exist

Do NOT report:
- fields that are empty. Those are already known and will be shown to the salesperson separately. Reporting them again wastes their attention.
- placeholder text such as TBD or N/A. Also already known.
- a preference for more detail where what is there is already specific enough to write from.
- anything about formatting, spelling or grammar.
- the absence of information a proposal does not need.

Be sparing. Three real findings are useful; ten findings including five speculative ones means the salesperson stops reading them. An empty array is a normal and correct answer for a well-filled form. Never report more than four.

SEVERITY. Default to advisory. Mark a finding blocking only when two answers directly contradict each other and a proposal cannot be written without resolving which is true - a ten-week scope against a two-day timeline, say. Vagueness is never blocking; a missing commercial term is never blocking. A blocking gap stops the proposal being approved by anyone, so a wall of them does not produce care, it produces a salesperson who waives all of them without reading. Spend that weight where it is earned.

Each question must be answerable in one line by someone who was on the call. "Is the £48,000 for the whole 10 weeks, or per phase?" is a good question. "Please provide more detail about pricing" is not.`;

/**
 * Runs the model pass and returns gap candidates, merged with nothing — the
 * caller combines these with the validator's own findings.
 *
 * On failure this returns an empty list rather than throwing. Generation is
 * still safe without it: the validator's blocking gaps are unaffected, the
 * model is separately instructed to emit [NEEDS INPUT: ...] markers while
 * drafting, and the grounding gate still runs afterwards. Losing the advisory
 * pass degrades the review; it does not let an invented fact through. The
 * failure is recorded as an ai_calls row either way.
 */
export async function analyseIntakeGaps(args: {
  intake: Intake;
  correlationId: string;
  proposalId: string;
}): Promise<{ gaps: GapCandidate[]; costMicroUsd: number; degraded: boolean }> {
  const known = validateIntake(args.intake);
  const knownList =
    known.length > 0
      ? known.map((g) => `- ${g.field ?? "general"}: ${g.message}`).join("\n")
      : "(none)";

  try {
    const result = await parseClaude<Analysis>({
      purpose: "gap_analysis",
      correlationId: args.correlationId,
      proposalId: args.proposalId,
      system: [{ type: "text", text: GAP_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `${intakeBlock(args.intake)}

# Already known, do not repeat these

${knownList}

Review the intake for contradictions and for answers too vague to write from. Return an empty array if there are none.`,
        },
      ],
      format: zodOutputFormat(analysisSchema),
    });

    const seen = new Set(known.map((g) => g.fingerprint));
    const gaps: GapCandidate[] = [];

    for (const g of result.parsed.gaps) {
      const message = g.question.trim().replace(/\s+/g, " ");
      if (message.length === 0) continue;

      const field = (INTAKE_FIELDS as readonly string[]).includes(g.field)
        ? (g.field as IntakeField)
        : null;
      const sectionKey = isSectionKey(g.section) ? g.section : null;
      const fingerprint = gapFingerprint({ sectionKey, field, message });

      // Belt and braces: the prompt says not to repeat known gaps, and this
      // drops any that slip through anyway.
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      gaps.push({
        sectionKey,
        field,
        severity: g.severity,
        message,
        detectedBy: "model",
        fingerprint,
      });
    }

    /**
     * The cap, enforced here as well as asked for in the prompt.
     *
     * An instruction is a request; this is the guarantee. The model is told to
     * report at most four and to reserve blocking for a genuine contradiction,
     * and both of those hold almost always - but "almost always" is not what
     * you want standing between a salesperson and a screen of red. Sorting
     * blocking first means the cap drops the least important findings rather
     * than an arbitrary tail.
     */
    const MAX_MODEL_GAPS = 4;
    const ranked = gaps
      .slice()
      .sort((a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking"))
      .slice(0, MAX_MODEL_GAPS);

    return { gaps: ranked, costMicroUsd: result.costMicroUsd, degraded: false };
  } catch {
    return { gaps: [], costMicroUsd: 0, degraded: true };
  }
}
