"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole } from "../../../lib/auth";
import { newCorrelationId, toAppError } from "../../../lib/errors";
import { recordEvent } from "../../../lib/audit";
import { intakeSchema, INTAKE_FIELDS } from "../../../lib/proposal/intake";
import { createProposal } from "../../../lib/proposal/repo";
import { ingestSources } from "../../../lib/proposal/ingest";
import { runGapAnalysis } from "../../../lib/proposal/service";

export type CreateState = {
  error: string | null;
  correlationId: string | null;
  fieldErrors: Record<string, string>;
};

// NOTE: a "use server" module may only export async functions. The initial
// state used to live here and arrived in the client as `undefined`, which blew
// up on the first property read. It is defined in the client component instead.

/**
 * Creates a proposal from the intake form.
 *
 * Three things worth pointing at:
 *
 * 1. IDEMPOTENCY. The form carries a key generated once when the page loads.
 *    A double submit, a retried POST, or an impatient second click all resolve
 *    to the same proposal rather than three near-identical drafts in the
 *    pipeline. See createProposal.
 *
 * 2. UPLOADS ARE NOT FATAL. Each attachment is extracted and stored with its
 *    own status. A corrupt PDF or a scan with no text layer records that fact
 *    against the source row and the proposal is still created — the
 *    salesperson is told what could not be read rather than losing the whole
 *    submission to one bad file.
 *
 * 3. THE CHEAP GATE RUNS IMMEDIATELY. The rule-based validator runs on create,
 *    for nothing, so gaps are visible before anyone asks Claude for anything.
 *    The paid model pass is left until generation.
 */
export async function createProposalAction(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const correlationId = newCorrelationId();
  let proposalId: string | null = null;

  try {
    const user = await requireRole("salesperson", "approver");

    const raw: Record<string, string> = {};
    for (const field of INTAKE_FIELDS) {
      raw[field] = String(formData.get(field) ?? "");
    }

    const parsed = intakeSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      await recordEvent({
        correlationId,
        action: "proposal.create",
        outcome: "error",
        actorId: user.id,
        errorCode: "VALIDATION_FAILED",
        detail: { fields: Object.keys(fieldErrors) },
      });
      return {
        error: "Some required details are missing.",
        correlationId: null,
        fieldErrors,
      };
    }

    const idempotencyKey = z
      .string()
      .min(8)
      .max(100)
      .parse(String(formData.get("idempotency_key") ?? ""));

    const { proposal, created } = await createProposal({
      authorId: user.id,
      intake: parsed.data,
      idempotencyKey,
    });
    proposalId = proposal.id;

    // A replayed submit lands here with created === false and simply goes to
    // the proposal the first submit made. No second draft, no error shown.
    if (created) {
      /**
       * Attachments, through the shared path.
       *
       * This used to be seventy lines inline. It now lives in
       * lib/proposal/ingest.ts because the workspace can attach files to an
       * existing proposal too, and two copies of the OCR decision, the
       * prompt-injection scan and the gap reconciliation would have drifted
       * apart on the first change to either.
       */
      await ingestSources({
        proposalId: proposal.id,
        actorId: user.id,
        correlationId,
        files: formData.getAll("sources").filter((f): f is File => f instanceof File),
      });

      // Free, rule-based only. The model pass costs money and waits for
      // generation, when the user has actually asked for something.
      await runGapAnalysis({ proposal, correlationId, cheapOnly: true });
    }

    await recordEvent({
      correlationId,
      action: "proposal.create",
      outcome: "ok",
      actorId: user.id,
      proposalId: proposal.id,
      detail: { created, ref: proposal.ref },
    });
  } catch (err) {
    const app = toAppError(err);
    await recordEvent({
      correlationId,
      action: "proposal.create",
      outcome: "error",
      errorCode: app.code,
      detail: { ...app.detail, message: app.message },
    });
    return { error: app.userMessage, correlationId, fieldErrors: {} };
  }

  // Outside the try: redirect() throws a control-flow signal that must not be
  // caught by the error handler above.
  redirect(`/proposals/${proposalId}`);
}
