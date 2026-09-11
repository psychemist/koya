import { z } from "zod";
import { stableHash, canonicalJson } from "../hash";
import { sectionsDependingOn, type SectionKey } from "./sections";

/**
 * The intake form, and the deterministic validator that runs before Claude is
 * ever called.
 *
 * The ordering matters and is the point. A model asked "is anything missing?"
 * will answer plausibly but not reliably, and it costs a request to find out.
 * Everything checkable by rule — is the field present, is it long enough to
 * mean something, is it a placeholder, is the date real, does the price
 * contain a number — is checked here for free, before a single token is spent.
 * Claude is then asked only the question rules cannot answer: is what is here
 * internally coherent and sufficient to write a proposal from.
 *
 * Fields mirror assets/intake-form-fields.md.
 */

export const INTAKE_FIELDS = [
  "client_name",
  "client_email",
  "company_name",
  "date_of_call",
  "salesperson_name",
  "client_needs_summary",
  "project_scope",
  "goals_and_objectives",
  "recommended_services",
  "proposed_timeline",
  "estimated_pricing",
] as const;

export type IntakeField = (typeof INTAKE_FIELDS)[number];

export const FIELD_LABELS: Record<IntakeField, string> = {
  client_name: "Client name",
  client_email: "Client email",
  company_name: "Company name",
  date_of_call: "Date of call",
  salesperson_name: "Salesperson",
  client_needs_summary: "Summary of client's needs",
  project_scope: "Project scope",
  goals_and_objectives: "Goals and objectives",
  recommended_services: "Recommended services or deliverables",
  proposed_timeline: "Proposed timeline",
  estimated_pricing: "Estimated pricing",
};

/**
 * Only four fields are hard-required by the form itself. The rest are allowed
 * through and become tracked gaps instead.
 *
 * That split is deliberate: a salesperson coming out of a call often has the
 * problem clearly and the price not at all, and a form that refuses to save
 * teaches them to type "TBD" into it — which is strictly worse than an empty
 * field, because a placeholder looks like an answer to everything downstream.
 * Saving early and marking the gap keeps the record honest.
 */
export const intakeSchema = z.object({
  client_name: z.string().trim().min(2, "Client name is required.").max(200),
  client_email: z.string().trim().max(320).optional().default(""),
  company_name: z.string().trim().min(2, "Company name is required.").max(200),
  date_of_call: z.string().trim().max(40).optional().default(""),
  salesperson_name: z.string().trim().min(2, "Salesperson name is required.").max(200),
  client_needs_summary: z
    .string()
    .trim()
    .min(20, "Describe the client's need in at least a sentence.")
    .max(5000),
  project_scope: z.string().trim().max(5000).optional().default(""),
  goals_and_objectives: z.string().trim().max(5000).optional().default(""),
  recommended_services: z.string().trim().max(5000).optional().default(""),
  proposed_timeline: z.string().trim().max(2000).optional().default(""),
  estimated_pricing: z.string().trim().max(2000).optional().default(""),
});

export type Intake = z.infer<typeof intakeSchema>;

/** A gap before it has a database row. */
export type GapCandidate = {
  sectionKey: SectionKey | null;
  field: IntakeField | null;
  severity: "blocking" | "advisory";
  message: string;
  detectedBy: "validator" | "model" | "grounding" | "scanner" | "style";
  fingerprint: string;
};

/**
 * The dedupe key for a gap. Not cryptographic on purpose — see lib/hash.ts.
 * Keeping it dependency-free is what lets `validateIntake` run in the browser,
 * which is what gives the intake form live gap feedback for free.
 */
export function gapFingerprint(
  parts: Pick<GapCandidate, "sectionKey" | "field" | "message">,
): string {
  return stableHash(canonicalJson({ s: parts.sectionKey, f: parts.field, m: parts.message }));
}

function gap(
  input: Omit<GapCandidate, "fingerprint" | "detectedBy"> & {
    detectedBy?: GapCandidate["detectedBy"];
  },
): GapCandidate {
  return {
    ...input,
    detectedBy: input.detectedBy ?? "validator",
    fingerprint: gapFingerprint(input),
  };
}

/**
 * Text that looks like an answer but is not one. Catching these is the whole
 * reason the validator exists: an empty field is obvious to everyone, whereas
 * "pricing: TBD" reads as filled-in to a form, to a model, and to a reviewer
 * skimming, and ends up in front of a client as invented pricing.
 */
const PLACEHOLDER = /^(tbd|tba|tbc|n\/?a|none|nil|null|unknown|\?+|-+|\.+|x+|todo|pending)$/i;

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (PLACEHOLDER.test(v)) return true;
  // "TBD - waiting on finance" is still a placeholder for our purposes.
  return /^(tbd|tba|tbc|todo|pending)\b/i.test(v);
}

function isMissing(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

/** Requires a digit; a price of "competitive" is not a price. */
const HAS_NUMBER = /\d/;
/** A duration token: 6 weeks, 3 months, Q3, 90 days, two sprints. */
const HAS_DURATION =
  /\b(\d+\s*(day|week|wk|month|mo|quarter|year|yr|sprint)s?|q[1-4]\b|(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month|quarter|year|sprint)s?)\b/i;

/**
 * Every check that can be made without a model call.
 *
 * Returns gaps only — it never rewrites or infers a value. Filling something
 * in on the user's behalf is precisely the "unsupported assumption" the PRD
 * asks the system not to make.
 */
export function validateIntake(intake: Intake, opts: { forDelivery?: boolean } = {}): GapCandidate[] {
  const gaps: GapCandidate[] = [];

  const firstSectionFor = (field: IntakeField): SectionKey | null =>
    sectionsDependingOn(field)[0] ?? null;

  /**
   * WHERE THE LINE BETWEEN BLOCKING AND ADVISORY SITS.
   *
   *   blocking  the field is EMPTY. There is nothing to write from, so the
   *             proposal would have to invent it.
   *   advisory  the field is filled and we doubt its quality. A placeholder,
   *             a price with no figure, a timeline with no duration.
   *
   * It used to be both, and that was too much. A form filled in quickly came
   * back with six or seven blocking gaps, most of them judgements about
   * wording rather than missing facts, and the effect of a wall of blockers is
   * not care - it is that people stop reading them and waive the lot. A gate
   * everybody clicks through is worse than a narrower gate they respect.
   *
   * The narrower rule still enforces "every field is filled", which is the
   * thing the approval step actually depends on. Everything else is surfaced,
   * counted, and left to the person.
   *
   * The one exception is the client's email address at delivery time, below:
   * an empty recipient is not a quality judgement, it is a send that cannot
   * happen.
   */

  // --- Fields whose absence stops a proposal being written honestly ---------
  const blockingFields: IntakeField[] = [
    "project_scope",
    "recommended_services",
    "proposed_timeline",
    "estimated_pricing",
  ];

  for (const field of blockingFields) {
    const value = intake[field];
    if (isMissing(value)) {
      gaps.push(
        gap({
          sectionKey: firstSectionFor(field),
          field,
          severity: "blocking",
          message: `${FIELD_LABELS[field]} is empty. The proposal cannot state this without a value from the call.`,
        }),
      );
    } else if (isPlaceholder(value)) {
      gaps.push(
        gap({
          sectionKey: firstSectionFor(field),
          field,
          // Advisory, not blocking. See the note on severity below.
          severity: "advisory",
          message: `${FIELD_LABELS[field]} reads as a placeholder ("${value.trim().slice(0, 40)}") rather than an answer. Worth replacing before this goes out.`,
        }),
      );
    }
  }

  // --- Shape checks on the two fields clients dispute most -----------------
  const pricing = intake.estimated_pricing;
  if (!isMissing(pricing) && !isPlaceholder(pricing) && !HAS_NUMBER.test(pricing)) {
    gaps.push(
      gap({
        sectionKey: "pricing",
        field: "estimated_pricing",
        severity: "advisory",
        message: `Pricing contains no figure ("${pricing.trim().slice(0, 40)}"). A proposal that describes a price without stating one invites the client to guess.`,
      }),
    );
  }

  const timeline = intake.proposed_timeline;
  if (!isMissing(timeline) && !isPlaceholder(timeline) && !HAS_DURATION.test(timeline)) {
    gaps.push(
      gap({
        sectionKey: "timeline",
        field: "proposed_timeline",
        severity: "advisory",
        message: `Timeline does not name a duration ("${timeline.trim().slice(0, 40)}"). The Timeline section will state only what is here.`,
      }),
    );
  }

  // --- Fields that weaken the proposal but do not stop it ------------------
  if (isMissing(intake.goals_and_objectives)) {
    gaps.push(
      gap({
        sectionKey: "introduction",
        field: "goals_and_objectives",
        severity: "advisory",
        message:
          "No goals or objectives captured. The Introduction will restate the need without naming the outcome the client wanted.",
      }),
    );
  }

  if (isMissing(intake.date_of_call)) {
    gaps.push(
      gap({
        sectionKey: null,
        field: "date_of_call",
        severity: "advisory",
        message: "Date of call is empty, so the proposal will carry today's date instead.",
      }),
    );
  } else {
    const parsed = parseLooseDate(intake.date_of_call);
    if (!parsed) {
      gaps.push(
        gap({
          sectionKey: null,
          field: "date_of_call",
          severity: "advisory",
          message: `Date of call ("${intake.date_of_call}") could not be read as a date, so it will be printed as written.`,
        }),
      );
    } else if (parsed.getTime() > Date.now() + 86_400_000) {
      gaps.push(
        gap({
          sectionKey: null,
          field: "date_of_call",
          severity: "advisory",
          message: `Date of call (${intake.date_of_call}) is in the future. Check it before sending.`,
        }),
      );
    }
  }

  // --- Email: advisory while drafting, blocking at the point of delivery ---
  // The address is not needed to write a proposal, and demanding it up front
  // would block work that can legitimately start without it. It is absolutely
  // needed to send one, so the same absence changes severity at that step.
  const email = intake.client_email;
  if (isMissing(email)) {
    gaps.push(
      gap({
        sectionKey: null,
        field: "client_email",
        severity: opts.forDelivery ? "blocking" : "advisory",
        message: opts.forDelivery
          ? "Client email is empty, so this proposal cannot be emailed. Add an address or deliver it by link instead."
          : "Client email is empty. It is not needed to draft, but delivery will ask for it.",
      }),
    );
  } else if (!isValidEmail(email)) {
    gaps.push(
      gap({
        sectionKey: null,
        field: "client_email",
        severity: opts.forDelivery ? "blocking" : "advisory",
        message: `Client email ("${email.trim().slice(0, 60)}") is not a valid address.`,
      }),
    );
  }

  // --- A summary that is technically long enough but says nothing ----------
  const summary = intake.client_needs_summary;
  if (!isMissing(summary) && countWords(summary) < 8) {
    gaps.push(
      gap({
        sectionKey: "introduction",
        field: "client_needs_summary",
        severity: "blocking",
        message:
          "The needs summary is too thin to write an Introduction from. A few more words about what the client actually said will change the whole proposal.",
      }),
    );
  }

  return gaps;
}

/**
 * A pragmatic email check, not RFC 5322. Something@something.tld with no
 * whitespace and one @ catches every real typo a salesperson makes; a full
 * grammar would accept addresses no mail server would.
 */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 6 || v.length > 320) return false;
  if (/\s/.test(v)) return false;
  const parts = v.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length < 3) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return /^[^@,;:<>"[\]\\]+$/.test(local);
}

export function countWords(value: string): number {
  const t = value.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Accepts what a person actually types into a date field: 2026-08-14,
 * 14/08/2026, 14 Aug 2026, August 14 2026. Returns null rather than guessing
 * when it cannot tell — an unreadable date becomes an advisory gap and is
 * printed verbatim, which is safer than silently resolving 03/04 to a month.
 */
export function parseLooseDate(value: string): Date | null {
  const v = value.trim();
  if (v.length === 0) return null;

  // ISO first: unambiguous.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // D/M/Y or D-M-Y. Day-first: this is a Lagos sales team, not a US one, and
  // guessing the other way turns 14/08 into an invalid date rather than a
  // wrong one — which at least fails loudly.
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(v);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    // Rejects 31 February rather than rolling it into March.
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d;
  }

  // Named months, either order.
  const named = Date.parse(v);
  if (!Number.isNaN(named) && /[a-z]{3}/i.test(v)) return new Date(named);

  return null;
}

/** Formats a date for the proposal header. Falls back to the raw string. */
export function formatCallDate(raw: string): string {
  const parsed = parseLooseDate(raw);
  if (!parsed) return raw.trim() || new Date().toISOString().slice(0, 10);
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

