/**
 * The section map.
 *
 * This is the single source of truth for a proposal's shape, and the reason
 * "regenerate one section without losing the rest" is straightforward rather
 * than delicate: sections are addressable, ordered rows, and each one declares
 * which intake fields it depends on.
 *
 * That `dependsOn` list is load-bearing in three places:
 *   - the validator knows which missing field blocks which section, so a gap
 *     is reported against the pricing section rather than "somewhere";
 *   - regeneration sends only the fields a section actually needs;
 *   - the grounding check knows which values a section was allowed to use.
 *
 * Derived from assets/proposal-template.md. The template nests Project Scope
 * and Recommended Approach under one numbered heading; they are separate
 * sections here because they are the two a salesperson most often rewrites
 * independently, and section granularity is the unit of regeneration.
 */

import type { IntakeField } from "./intake";

export type SectionKey =
  | "introduction"
  | "project_scope"
  | "recommended_approach"
  | "deliverables"
  | "timeline"
  | "pricing"
  | "next_steps";

export type SectionDef = {
  key: SectionKey;
  /** Heading as it appears in the finished document. */
  heading: string;
  /** Numbered group from the template, for rendering "2. Proposed Solution". */
  group: string;
  position: number;
  /** Intake fields this section is allowed to draw on. */
  dependsOn: IntakeField[];
  /** What this section is for, in the model's instructions. */
  brief: string;
  /** Rough target, given to the model as guidance rather than a hard cap. */
  targetWords: [number, number];
  /**
   * True when the section is boilerplate that does not vary with the deal.
   * Next Steps is the same courtesy close every time, so it is written from
   * the template without spending a model call on it.
   */
  deterministic?: boolean;
};

export const SECTIONS: readonly SectionDef[] = [
  {
    key: "introduction",
    heading: "Introduction",
    group: "1. Introduction",
    position: 1,
    dependsOn: ["client_name", "company_name", "client_needs_summary", "goals_and_objectives"],
    brief:
      "Thank the client for the discovery call, restate the problem they described in their own terms, and name the outcome they said they wanted. Show you listened; do not sell yet.",
    targetWords: [90, 150],
  },
  {
    key: "project_scope",
    heading: "Project Scope",
    group: "2. Proposed Solution",
    position: 2,
    dependsOn: ["project_scope", "client_needs_summary", "company_name"],
    brief:
      "State plainly what is included and, where the intake makes it clear, what is not. Boundaries prevent scope disputes later, so be concrete about the edges.",
    targetWords: [110, 200],
  },
  {
    key: "recommended_approach",
    heading: "Recommended Approach",
    group: "2. Proposed Solution",
    position: 3,
    dependsOn: ["recommended_services", "project_scope", "goals_and_objectives", "proposed_timeline"],
    brief:
      "Explain how the work will be done in sequenced phases, and why this sequence suits the client's constraints. This is the section where supporting material about the client's systems or team should be used if any was provided.",
    targetWords: [150, 260],
  },
  {
    key: "deliverables",
    heading: "Deliverables",
    group: "3. Deliverables",
    position: 4,
    dependsOn: ["recommended_services", "project_scope"],
    brief:
      "A markdown bullet list of concrete, checkable artefacts the client receives. Every bullet must be a thing that can be handed over, not an activity.",
    targetWords: [70, 160],
  },
  {
    key: "timeline",
    heading: "Timeline",
    group: "4. Timeline",
    position: 5,
    dependsOn: ["proposed_timeline", "recommended_services"],
    brief:
      "Give the duration and phase breakdown exactly as supplied. Do not invent dates, and do not convert a duration into calendar dates unless the intake gives a start date.",
    targetWords: [60, 130],
  },
  {
    key: "pricing",
    heading: "Pricing",
    group: "5. Pricing",
    position: 6,
    dependsOn: ["estimated_pricing", "recommended_services", "proposed_timeline"],
    brief:
      "State the price exactly as supplied, including its currency and whether it is a range, a fixed fee, or a rate. Say what it covers. Never compute, discount, annualise, or round a figure the intake did not contain.",
    targetWords: [60, 140],
  },
  {
    key: "next_steps",
    heading: "Next Steps",
    group: "6. Next Steps",
    position: 7,
    dependsOn: ["salesperson_name"],
    brief:
      "The standard close: agreement to formalise the engagement, an invitation to ask questions, and a warm sign-off from the salesperson.",
    targetWords: [50, 90],
    // Identical for every deal. Written from the template, no model call.
    deterministic: true,
  },
] as const;

export const SECTION_BY_KEY: Record<SectionKey, SectionDef> = Object.fromEntries(
  SECTIONS.map((s) => [s.key, s]),
) as Record<SectionKey, SectionDef>;

export const SECTION_KEYS: readonly SectionKey[] = SECTIONS.map((s) => s.key);

/** The sections that cost a model call. Used for cost estimates and progress. */
export const AI_SECTION_KEYS: readonly SectionKey[] = SECTIONS.filter(
  (s) => !s.deterministic,
).map((s) => s.key);

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === "string" && SECTION_KEYS.includes(value as SectionKey);
}

/** Which sections a given intake field feeds. Drives gap-to-section mapping. */
export function sectionsDependingOn(field: IntakeField): SectionKey[] {
  return SECTIONS.filter((s) => s.dependsOn.includes(field)).map((s) => s.key);
}
