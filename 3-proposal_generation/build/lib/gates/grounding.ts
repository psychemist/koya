import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { parseClaude } from "../claude/client";
import { stripCitationMarkers, stripGapMarkers } from "../proposal/parse";
import { gapFingerprint, type GapCandidate, type Intake } from "../proposal/intake";
import { isSectionKey, type SectionKey } from "../proposal/sections";
import { findUngrounded } from "./numbers";

/**
 * The grounding gate: does the proposal only say things it was told?
 *
 * Two passes, cheap first.
 *
 *   Pass 1 (free, deterministic) — every money figure, percentage, duration
 *   and date must appear in the inputs. This catches the failure that actually
 *   costs money, because inventing a figure is arithmetic and arithmetic is
 *   mechanically detectable. See numbers.ts.
 *
 *   Pass 2 (one Haiku call) — qualitative claims that carry no number and so
 *   are invisible to pass 1: "we have delivered this for three other logistics
 *   firms", "your Sage instance will need upgrading", "this integrates with
 *   your existing CRM". A rule cannot see these; a model can.
 *
 * Pass 2 runs once for the whole document rather than once per section. Seven
 * calls would cost seven times as much and would lose the cross-section view
 * that catches a claim introduced in one section and contradicted in another.
 */

const judgeSchema = z.object({
  unsupported: z
    .array(
      z.object({
        section: z
          .string()
          .describe("The section key the claim appears in, exactly as given in the input."),
        quote: z
          .string()
          .describe("The claim, quoted verbatim from the proposal, at most 25 words."),
        why: z
          .string()
          .describe(
            "One sentence: what specific fact this asserts that the inputs do not contain.",
          ),
        severity: z
          .enum(["blocking", "advisory"])
          .describe(
            "blocking if a client could act on it or hold us to it; advisory if it is merely unsupported colour.",
          ),
      }),
    )
    .describe("Claims not supported by the inputs. Empty array if everything checks out."),
});

type JudgeResult = z.infer<typeof judgeSchema>;

const JUDGE_SYSTEM = `You verify a draft proposal against the only source material its author was given. You are the last check before a human reviewer, and your job is narrow.

Report a claim ONLY when the proposal asserts something as fact that the SOURCE MATERIAL does not contain. In particular:
- capabilities, experience, credentials, or past clients of the supplier
- statements about the client's systems, tools, team, or processes
- guarantees, commitments, or outcomes that were never offered
- specifics presented as agreed when they were not

Do NOT report:
- text inside a [NEEDS INPUT: ...] marker. That is the author correctly flagging a gap, and it is the behaviour we want.
- ordinary professional courtesy: thanking the client, expressing interest, offering to answer questions, looking forward to working together.
- restatements, summaries or rephrasings of the source material, including using different words for the same idea.
- generic descriptions of how consulting work proceeds (discovery, build, review, handover) that claim no specific fact.
- anything with a number in it. Figures are checked separately and reporting them here produces duplicates.

Quote verbatim and keep quotes under 25 words. If everything is supported, return an empty array. An empty array is a normal, common, correct answer. Do not invent findings to seem useful.`;

export type GroundingFinding = {
  sectionKey: SectionKey | null;
  severity: "blocking" | "advisory";
  message: string;
  source: "numbers" | "judge";
};

/**
 * The deterministic pass. Pure, free, and safe to run on every save.
 *
 * Gap markers are stripped before checking: a marker's text is a question, not
 * a claim, and "[NEEDS INPUT: is the fee £48,000 or £52,000?]" would otherwise
 * report £52,000 as an invented figure when it is the opposite — the author
 * declining to pick one.
 */
export function checkNumbers(
  sections: { key: SectionKey; body: string }[],
  allowedText: string,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];
  for (const section of sections) {
    const checkable = stripCitationMarkers(stripGapMarkers(section.body));
    for (const f of findUngrounded(checkable, allowedText)) {
      findings.push({
        sectionKey: section.key,
        severity: f.kind === "money" ? "blocking" : "advisory",
        message: f.reason,
        source: "numbers",
      });
    }
  }
  return findings;
}

/**
 * Builds the text a proposal is permitted to draw on: every intake value plus
 * every extracted source document.
 */
export function allowedTextFor(
  intake: Intake,
  sources: readonly { filename: string; text: string }[],
): string {
  const intakeLines = Object.entries(intake)
    .map(([k, v]) => `${k}: ${String(v ?? "")}`)
    .join("\n");
  const sourceText = sources.map((s) => `--- ${s.filename} ---\n${s.text}`).join("\n\n");
  return `${intakeLines}\n\n${sourceText}`;
}

/**
 * Pass 2. One Haiku call for the whole document.
 *
 * Returns [] rather than throwing when the judge itself fails. The reasoning:
 * this pass is an *additional* safety net on top of pass 1 and a human
 * reviewer, and refusing to show a salesperson their finished draft because an
 * advisory check was unavailable trades a real failure for a hypothetical one.
 * The failure is still recorded as an ai_calls row with its error code, so it
 * is visible on the System page rather than silent.
 */
export async function judgeClaims(args: {
  sections: { key: SectionKey; heading: string; body: string }[];
  allowedText: string;
  correlationId: string;
  proposalId: string;
}): Promise<{ findings: GroundingFinding[]; costMicroUsd: number; degraded: boolean }> {
  const withProse = args.sections.filter((s) => s.body.trim().length > 0);
  if (withProse.length === 0) {
    return { findings: [], costMicroUsd: 0, degraded: false };
  }

  const proposalText = withProse
    .map((s) => `## ${s.key}: ${s.heading}\n\n${s.body}`)
    .join("\n\n");

  try {
    const result = await parseClaude<JudgeResult>({
      purpose: "grounding_judge",
      correlationId: args.correlationId,
      proposalId: args.proposalId,
      system: [
        // The instructions are identical on every judge call ever made, so
        // they sit in their own cached block ahead of the volatile content.
        { type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `# SOURCE MATERIAL\n\n${args.allowedText}\n\n# DRAFT PROPOSAL\n\n${proposalText}`,
        },
      ],
      format: zodOutputFormat(judgeSchema),
    });

    const findings: GroundingFinding[] = result.parsed.unsupported.map((u) => ({
      sectionKey: isSectionKey(u.section) ? u.section : null,
      severity: u.severity,
      message: `"${u.quote.trim()}": ${u.why.trim()}`,
      source: "judge",
    }));

    return { findings, costMicroUsd: result.costMicroUsd, degraded: false };
  } catch {
    // Recorded by parseClaude as a failed ai_calls row before it threw.
    return { findings: [], costMicroUsd: 0, degraded: true };
  }
}

/** Converts grounding findings into gap candidates for the database. */
export function findingsToGaps(findings: readonly GroundingFinding[]): GapCandidate[] {
  return findings.map((f) => ({
    sectionKey: f.sectionKey,
    field: null,
    severity: f.severity,
    message: f.message,
    detectedBy: "grounding" as const,
    fingerprint: gapFingerprint({ sectionKey: f.sectionKey, field: null, message: f.message }),
  }));
}
