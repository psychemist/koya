import { intakeSchema, type Intake } from "../lib/proposal/intake";

/**
 * The three intakes the test suite and the demo run against.
 *
 * They map onto the PRD's first three test scenarios deliberately: a complete
 * form, a form with important details missing, and a form whose value depends
 * on attached supporting material. Everything here is fictional — no real
 * client, no real person, no real address — because fixtures end up in
 * screenshots and demo videos.
 */

export const COMPLETE_INTAKE: Intake = intakeSchema.parse({
  client_name: "Amara Diallo",
  client_email: "amara.diallo@meridian-logistics.example",
  company_name: "Meridian Logistics",
  date_of_call: "2026-08-14",
  salesperson_name: "Ada Okonkwo",
  client_needs_summary:
    "Their dispatch team receives delivery notes by email and as scans, then rekeys every one of them by hand into both the order system and the finance system. Amara said it takes two people most of the morning, and the mistakes are costing them credit notes with three of their larger customers.",
  project_scope:
    "Capture delivery notes from the shared dispatch inbox and from scanned uploads, read the line items, validate them against the matching order, and write the result into both the order system and the finance system. Exceptions go to a review queue rather than being guessed at. Out of scope: changes to the finance system itself, and anything touching customer invoicing.",
  goals_and_objectives:
    "Cut the morning rekeying work so the two dispatch staff can spend that time on customer calls, and stop the data-entry errors that lead to credit notes.",
  recommended_services:
    "Discovery workshop with the dispatch and finance teams; build of the capture and validation pipeline; integration into the order and finance systems; a review queue for exceptions; two weeks of hypercare after go-live; handover training and written runbook.",
  proposed_timeline: "10 weeks across three phases, starting on signature.",
  estimated_pricing: "£48,000 fixed fee, invoiced in three milestones.",
});

/**
 * The missing-information case.
 *
 * Note what is here and what is not: enough to describe a real problem, and
 * nothing at all about scope, services, timeline or price. This is a realistic
 * post-call state, not an artificially empty form — a salesperson often has
 * the problem clearly and the commercials not at all.
 */
export const MISSING_INTAKE: Intake = intakeSchema.parse({
  client_name: "Tobi Adeyemi",
  company_name: "Harcourt Facilities Management",
  date_of_call: "2026-08-21",
  salesperson_name: "Ada Okonkwo",
  client_needs_summary:
    "Tobi's team manages maintenance across 40 commercial sites and tracks all of it in spreadsheets. He said nobody can answer 'what is outstanding at site X' without half an hour of digging, and their compliance reporting is done from memory.",
  project_scope: "",
  goals_and_objectives: "",
  recommended_services: "",
  proposed_timeline: "TBD",
  estimated_pricing: "",
  client_email: "",
});

/**
 * The supporting-material case. The intake is deliberately thin on the
 * client's technical constraints, because that detail lives only in the
 * attached brief — so a proposal that uses the attachment is visibly better
 * than one that does not, which is what makes the test meaningful.
 */
export const SOURCED_INTAKE: Intake = intakeSchema.parse({
  client_name: "Priya Raman",
  client_email: "priya.raman@northgate-clinics.example",
  company_name: "Northgate Clinics",
  date_of_call: "2026-08-27",
  salesperson_name: "Ada Okonkwo",
  client_needs_summary:
    "Referral letters arrive by post and secure email and are triaged by hand. Priya wants the triage step to stop being the bottleneck that delays urgent referrals.",
  project_scope:
    "Automate intake and triage of inbound referral letters, route by urgency, and surface anything that needs a clinician's eye.",
  goals_and_objectives:
    "Get urgent referrals in front of a clinician the same day, and remove the manual sorting step entirely.",
  recommended_services:
    "Discovery and process mapping, triage automation build, integration with their patient administration system, clinician review interface, and staff training.",
  proposed_timeline: "14 weeks in four phases.",
  estimated_pricing: "£72,000, split across four phase payments.",
});

/**
 * The attached brief for the sourced case, as plain text.
 *
 * Contains three things the intake does not: the named PAS, the on-premises
 * constraint, and the retention rule. A proposal that mentions any of them
 * demonstrably used the attachment, which is exactly what the PRD's third test
 * asks to be shown.
 */
export const SOURCE_BRIEF = `Northgate Clinics — Referral Handling: Background Notes
Prepared for the discovery call, 27 August 2026

Current position
Referral letters reach us three ways: post to the central office, NHS-secure
email to a shared mailbox, and occasional fax from two older GP practices. A
band 4 administrator opens everything, decides urgency by reading the letter,
and types the patient details into our patient administration system.

Systems
Our patient administration system is Medibase PAS, version 9.4. It is hosted
on our own servers in the Northgate basement data room; it is not a cloud
product and our IT policy does not permit patient data to leave our network.
Medibase exposes a SOAP interface for record creation which our previous
supplier used successfully.

Constraints we cannot move on
- Patient-identifiable data must remain on our infrastructure. Any processing
  that would send letter contents to an external service needs an information
  governance review that takes eight weeks minimum.
- We retain referral correspondence for eight years under our records policy.
- The clinical safety officer must sign off any change to how urgency is
  determined. She will not accept a system that assigns urgency without a
  clinician being able to see and override the decision.

What good looks like
Urgent referrals reaching a clinician the same working day. The administrator
spending her time on patient contact rather than sorting paper. No change to
how clinicians work day to day beyond a single review screen.

Volumes
Roughly 320 referrals a week across all sites, rising in winter. About 12 per
cent are marked urgent by the referring practice, and our own audit found a
further 4 per cent should have been.`;

export const FIXTURES = {
  complete: { intake: COMPLETE_INTAKE, sources: [] as { filename: string; text: string }[] },
  missing: { intake: MISSING_INTAKE, sources: [] as { filename: string; text: string }[] },
  sourced: {
    intake: SOURCED_INTAKE,
    sources: [{ filename: "northgate-background-notes.txt", text: SOURCE_BRIEF }],
  },
} as const;

export type FixtureName = keyof typeof FIXTURES;
