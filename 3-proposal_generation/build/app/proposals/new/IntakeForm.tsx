"use client";

import { INTAKE_FIELD_SPECS as FIELDS } from "../../../lib/proposal/fields";
import { useActionState, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  FIELD_LABELS,
  intakeSchema,
  validateIntake,
  type Intake,
  type IntakeField,
} from "../../../lib/proposal/intake";
import {
  ACCEPTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_SOURCES_PER_PROPOSAL,
  formatBytes,
} from "../../../lib/limits";
import { Badge, ErrorNote, InfoNote } from "../../../components/ui";
import { createProposalAction } from "./actions";
import type { CreateState } from "./actions";

/**
 * The intake form.
 *
 * The live checks panel on the right is the whole reason `validateIntake` was
 * made dependency-free: it is the exact same function the server runs, so what
 * the salesperson sees while typing cannot disagree with what gets stored.
 * Duplicating the rules in a client-side copy would have been the obvious
 * shortcut and the obvious source of drift.
 *
 * Nothing here fills a field in on the user's behalf. The panel says what is
 * missing and what it will cost the proposal; it never guesses a value.
 */

/**
 * Defined here rather than exported from actions.ts: a "use server" module may
 * only export async functions, so a plain object exported from it reaches the
 * client as undefined.
 */
const INITIAL_CREATE_STATE: CreateState = {
  error: null,
  correlationId: null,
  fieldErrors: {},
};

function emptyIntake(): Record<IntakeField, string> {
  return {
    client_name: "",
    client_email: "",
    company_name: "",
    date_of_call: "",
    salesperson_name: "",
    client_needs_summary: "",
    project_scope: "",
    goals_and_objectives: "",
    recommended_services: "",
    proposed_timeline: "",
    estimated_pricing: "",
  };
}

/**
 * The submit control, kept in view.
 *
 * This form is around 1,900px tall and its only button was at the bottom of
 * it, which made "have I done enough to save this?" a question you could only
 * answer by scrolling to the end and back. Sticking the bar to the bottom of
 * the viewport keeps the answer, the button and the open-gap count together
 * the whole way down, and costs one row of height.
 */
function SubmitButton({ blocking }: { blocking: number }) {
  const { pending } = useFormStatus();
  return (
    <div className="action-bar">
      <button type="submit" className="btn btn-primary btn-lg" disabled={pending}>
        {pending ? "Saving…" : "Save and open workspace"}
      </button>
      <span className="hint m-0 flex-1">
        {blocking > 0
          ? `Saving is fine with ${blocking} gap${blocking === 1 ? "" : "s"} open. They travel with the proposal and block approval, not saving.`
          : "Nothing is sent to Claude yet. You choose when to draft."}
      </span>
    </div>
  );
}

export function IntakeForm({ salespersonName }: { salespersonName: string }) {
  const [state, formAction] = useActionState(createProposalAction, INITIAL_CREATE_STATE);
  const [values, setValues] = useState<Record<IntakeField, string>>(() => ({
    ...emptyIntake(),
    salesperson_name: salespersonName,
  }));
  const [files, setFiles] = useState<File[]>([]);

  /**
   * Generated once per mounted form, not per submit. That is what makes it an
   * idempotency key rather than a request id: a retry of the same form must
   * carry the same value.
   */
  const idempotencyKey = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // The same validator the server runs. Parsed leniently so a half-filled form
  // still produces useful feedback rather than a schema error.
  const gaps = useMemo(() => {
    const parsed = intakeSchema.safeParse(values);
    const intake: Intake = parsed.success
      ? parsed.data
      : ({ ...emptyIntake(), ...values } as Intake);
    return validateIntake(intake);
  }, [values]);

  const blocking = gaps.filter((g) => g.severity === "blocking");
  const advisory = gaps.filter((g) => g.severity === "advisory");
  const gapByField = new Map(blocking.filter((g) => g.field).map((g) => [g.field, g]));

  const set = (name: IntakeField, value: string) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  return (
    <form action={formAction} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <input type="hidden" name="idempotency_key" value={idempotencyKey.current} />

      <div className="flex flex-col gap-5">
        {state.error ? (
          <ErrorNote message={state.error} correlationId={state.correlationId} />
        ) : null}

        <div className="panel flex flex-col gap-5 p-5">
          <div>
            <h2 className="panel-title mb-1">Who, and when</h2>
            <p className="hint mt-0 mb-3.5">
              The four required fields are here and in the summary below. Everything else is
              worth having and none of it is worth inventing.
            </p>
            {/*
              A hole in a two-column grid.

              There are seven short fields, so an even grid leaves the last
              cell empty and the form ends on a ragged edge that reads as a
              missing field rather than as a finished row. The last item of an
              odd-length group takes the full width instead, which is an
              ordinary thing for a form to do and needs no reordering of the
              field list to stay true when a field is added or removed.
            */}
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.filter((f) => f.type !== "textarea").map((field, index, all) => (
                <div
                  key={field.name}
                  className={
                    index === all.length - 1 && all.length % 2 === 1 ? "sm:col-span-2" : ""
                  }
                >
                  <label className="field-label" htmlFor={field.name}>
                    {FIELD_LABELS[field.name]}
                    {field.required ? (
                      <span className="text-[var(--bad)]" aria-hidden="true">
                        {" "}
                        *
                      </span>
                    ) : null}
                  </label>
                  <input
                    id={field.name}
                    name={field.name}
                    type={field.type}
                    className="input"
                    placeholder={field.placeholder}
                    value={values[field.name]}
                    onChange={(e) => set(field.name, e.target.value)}
                    required={field.required}
                    data-gap={gapByField.has(field.name) ? "blocking" : undefined}
                    aria-describedby={`${field.name}-hint`}
                    aria-invalid={state.fieldErrors[field.name] ? true : undefined}
                  />
                  <div className="hint" id={`${field.name}-hint`}>
                    {state.fieldErrors[field.name] ? (
                      <span className="text-[var(--bad)]">{state.fieldErrors[field.name]}</span>
                    ) : (
                      field.hint
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-[var(--border)] pt-5">
            <h2 className="panel-title mb-1">What they said on the call</h2>
            <p className="hint mt-0 mb-3.5">
              Their words where you have them. The proposal reuses them rather than
              paraphrasing, which is what stops it sounding like a template.
            </p>
            <div className="flex flex-col gap-4">
              {FIELDS.filter((f) => f.type === "textarea").map((field) => (
                <div key={field.name}>
                  <label className="field-label" htmlFor={field.name}>
                    {FIELD_LABELS[field.name]}
                    {field.required ? (
                      <span className="text-[var(--bad)]" aria-hidden="true">
                        {" "}
                        *
                      </span>
                    ) : null}
                  </label>
                  <textarea
                    id={field.name}
                    name={field.name}
                    className="textarea"
                    rows={field.rows ?? 3}
                    placeholder={field.placeholder}
                    value={values[field.name]}
                    onChange={(e) => set(field.name, e.target.value)}
                    required={field.required}
                    data-gap={gapByField.has(field.name) ? "blocking" : undefined}
                    aria-describedby={`${field.name}-hint`}
                    aria-invalid={state.fieldErrors[field.name] ? true : undefined}
                  />
                  <div className="hint" id={`${field.name}-hint`}>
                    {state.fieldErrors[field.name] ? (
                      <span className="text-[var(--bad)]">{state.fieldErrors[field.name]}</span>
                    ) : (
                      field.hint
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel p-5">
          <h2 className="panel-title">Supporting material</h2>
          <p className="hint mt-1 mb-3">
            A brief, a scoping note, an email thread. Claude may use anything relevant in it
            and must cite the document for any claim that comes from it. PDF, Word or plain
            text, up to {formatBytes(MAX_UPLOAD_BYTES)} each, {MAX_SOURCES_PER_PROPOSAL} files
            maximum.
          </p>

          {/*
            A file input renders as the operating system's own button, and that
            grey "Choose Files" control was the one thing on this page drawn by
            a different design than everything around it. The input is still
            here and still the thing that gets focused and clicked; it has been
            taken out of the layout and given a label the size of the action.
          */}
          <label className="dropzone" htmlFor="sources">
            <span className="dropzone-glyph" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 11V3m0 0L5 6m3-3l3 3M2.5 10.5v1A2 2 0 004.5 13.5h7a2 2 0 002-2v-1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="t-base font-medium text-[var(--ink)]">
              {files.length > 0
                ? `${files.length} file${files.length === 1 ? "" : "s"} chosen. Click to change.`
                : "Choose files"}
            </span>
            <span className="hint m-0">PDF, Word or plain text</span>
            <input
              id="sources"
              name="sources"
              type="file"
              multiple
              accept={ACCEPTED_UPLOAD_TYPES}
              className="dropzone-input"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1.5">
              {files.map((f) => {
                const tooBig = f.size > MAX_UPLOAD_BYTES;
                return (
                  <li
                    key={`${f.name}-${f.size}`}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 t-sm"
                  >
                    <span className="truncate">{f.name}</span>
                    {tooBig ? (
                      <Badge tone="bad" glyph="■">
                        Too large, will be skipped
                      </Badge>
                    ) : (
                      <span className="text-[var(--muted)]">{formatBytes(f.size)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

        </div>

        <SubmitButton blocking={blocking.length} />
      </div>

      {/* ---- live checks ---- */}
      <aside className="flex flex-col gap-3 lg:sticky lg:top-[72px] lg:self-start">
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="panel-title">Checks</h2>
            {blocking.length === 0 && advisory.length === 0 ? (
              <Badge tone="good" glyph="✓">
                Clear
              </Badge>
            ) : (
              <span className="flex gap-1.5">
                {blocking.length > 0 ? (
                  <Badge tone="attention" glyph="▲">
                    {blocking.length}
                  </Badge>
                ) : null}
                {advisory.length > 0 ? (
                  <Badge tone="neutral" glyph="·">
                    {advisory.length}
                  </Badge>
                ) : null}
              </span>
            )}
          </div>

          <p className="hint mt-1 mb-3">
            These run as you type, on your machine, for nothing. The same rules run again on
            the server.
          </p>

          {gaps.length === 0 ? (
            <InfoNote tone="good">
              Nothing missing. Claude will still mark anything it cannot support while
              drafting.
            </InfoNote>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...blocking, ...advisory].map((gap) => (
                <li
                  key={gap.fingerprint}
                  className={`rounded-[var(--radius-sm)] border px-2.5 py-2 t-sm leading-relaxed ${
                    gap.severity === "blocking"
                      ? "border-[var(--attention-line)] bg-[var(--attention-soft)]"
                      : "border-[var(--border)] bg-[var(--surface-2)]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="t-2xs">
                      {gap.severity === "blocking" ? "▲" : "·"}
                    </span>
                    <span className="t-xs font-semibold uppercase tracking-wide">
                      {gap.severity === "blocking" ? "Blocks approval" : "Advisory"}
                    </span>
                  </div>
                  <p className="m-0 mt-1 text-[var(--ink-2)]">{gap.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel p-4">
          <h2 className="panel-title">What happens next</h2>
          {/*
            Tailwind's preflight removes list markers, so this rendered as five
            indented paragraphs with no numbers at all: the one list on the page
            whose entire job is to say what order things happen in had lost the
            order. `.steps` draws its own.
          */}
          <ol className="steps mt-3 t-sm leading-relaxed text-[var(--ink-2)]">
            <li>Saving costs nothing and calls no model.</li>
            <li>
              In the workspace you press Draft. Claude writes the seven sections and marks
              anything it cannot support.
            </li>
            <li>You revise, section by section. Regenerating one leaves the rest alone.</li>
            <li>
              Somebody else signs it off. You cannot approve your own, and blocking gaps
              must be resolved or waived in writing before anyone can.
            </li>
            <li>Only then can it reach the client.</li>
          </ol>
        </div>
      </aside>
    </form>
  );
}
