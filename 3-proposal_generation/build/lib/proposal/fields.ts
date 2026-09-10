import type { IntakeField } from "./intake";

/**
 * How each intake field is presented.
 *
 * Extracted from the create form so the workspace editor uses the same
 * definitions rather than a second copy. Two lists would drift the first
 * time a hint changed, and a placeholder that contradicts the one a
 * salesperson saw when they filled the form in is worse than none.
 */
export type FieldSpec = {
  name: IntakeField;
  type: "text" | "email" | "date" | "textarea";
  placeholder?: string;
  hint?: string;
  rows?: number;
  required?: boolean;
};

export const INTAKE_FIELD_SPECS: FieldSpec[] = [
  {
    name: "client_name",
    type: "text",
    required: true,
    placeholder: "Amara Diallo",
    hint: "The person you spoke to.",
  },
  {
    name: "client_email",
    type: "email",
    placeholder: "amara@company.example",
    hint: "Not needed to draft. Needed to send.",
  },
  { name: "company_name", type: "text", required: true, placeholder: "Meridian Logistics" },
  {
    name: "date_of_call",
    type: "date",
    hint: "Leave blank and the proposal carries today's date.",
  },
  { name: "salesperson_name", type: "text", required: true, placeholder: "Ada Okonkwo" },
  {
    name: "client_needs_summary",
    type: "textarea",
    required: true,
    rows: 5,
    placeholder:
      "What did they say the problem was? Use their own words where you can. The proposal will reuse them.",
    hint: "The single most important field. Everything in the Introduction comes from here.",
  },
  {
    name: "project_scope",
    type: "textarea",
    rows: 4,
    placeholder: "What is in. Then what is out, which is usually the more useful half.",
    hint: "Naming what is out of scope is what prevents an argument later.",
  },
  {
    name: "goals_and_objectives",
    type: "textarea",
    rows: 3,
    placeholder: "The outcome they said they wanted.",
  },
  {
    name: "recommended_services",
    type: "textarea",
    rows: 4,
    placeholder: "Workshops, build, integration, training…",
  },
  {
    name: "proposed_timeline",
    type: "text",
    placeholder: "10 weeks across three phases",
    hint: "State a duration. It will not be converted into calendar dates.",
  },
  {
    name: "estimated_pricing",
    type: "text",
    placeholder: "£48,000 fixed fee, invoiced in three milestones",
    hint: "Include the currency. The figure is reproduced exactly as written and never recalculated.",
  },
];
