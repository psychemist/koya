"use client";

import { useState } from "react";
import { FIELD_LABELS, type Intake, type IntakeField } from "../../lib/proposal/intake";
import { INTAKE_FIELD_SPECS } from "../../lib/proposal/fields";
import { Caret } from "../ui";

/**
 * Editing the call notes after the proposal exists.
 *
 * WHY THIS WAS MISSING AND WHY IT MATTERS. The endpoint behind it has been
 * there since the beginning, and its own comment calls it "the usual way a
 * blocking gap gets resolved, since most of them are a missing field".
 * Nothing in the interface ever called it. So the intake was write-once
 * through the create form, and the most ordinary correction in the whole
 * application, a mistyped client email, could only be made with a hand-
 * written PATCH request.
 *
 * That is worse than an inconvenience. Most blocking gaps say a field is
 * empty, and the panel telling you so offered exactly two ways forward:
 * resolve it, which does nothing if the field is still empty and reopens on
 * the next run, or waive it, which puts a written excuse in the audit trail
 * for something that could simply have been typed in. The gate was pushing
 * people toward waivers because the honest option had no button.
 *
 * Collapsed by default. It is a correction, not part of the writing loop,
 * and expanded it is eleven fields in a 340px rail.
 */

type Notice = { tone: "good" | "bad" | "neutral"; message: string; correlationId?: string | null };

export function IntakeEditor({
  proposalId,
  intake,
  editable,
  onNotice,
  onGaps,
  lockedReason,
}: {
  proposalId: string;
  intake: Intake;
  editable: boolean;
  onNotice: (notice: Notice) => void;
  onGaps: () => void;
  lockedReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...intake }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = INTAKE_FIELD_SPECS.some(
    (f) => (draft[f.name] ?? "") !== ((intake[f.name] as string | undefined) ?? ""),
  );

  /** Fields with nothing in them, which is what most blocking gaps are about. */
  const empty = INTAKE_FIELD_SPECS.filter(
    (f) => ((intake[f.name] as string | undefined) ?? "").trim().length === 0,
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/intake`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: { message: string; correlationId?: string };
      };
      if (!res.ok || !payload.ok) {
        setError(payload.error?.message ?? "Those details could not be saved.");
        return;
      }
      onGaps();
      onNotice({
        tone: "good",
        message:
          "Call details saved. The checks re-ran, so any gap about a missing field has closed by itself.",
      });
      setOpen(false);
    } catch {
      setError("Could not reach the server. Nothing was changed, and your edits are still here.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rail-section">
      <button
        type="button"
        className="disclosure"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <span className="rail-title">Call details</span>
          {empty.length > 0 ? (
            <span className="badge badge-attention">
              <span aria-hidden="true" className="t-2xs">
                ▲
              </span>
              {empty.length} empty
            </span>
          ) : null}
          {dirty ? (
            <span className="badge badge-attention">
              <span aria-hidden="true" className="t-2xs">
                ●
              </span>
              unsaved
            </span>
          ) : null}
        </span>
        <Caret />
      </button>

      {!open ? (
        <p className="hint mt-1 mb-0">
          {empty.length > 0
            ? `What you took from the call. ${empty.length} field${empty.length === 1 ? " is" : "s are"} empty, which is what most blocking gaps are about.`
            : "What you took from the call. Edit it here and the checks re-run."}
        </p>
      ) : null}

      {open ? (
        <div className="mt-2 flex flex-col gap-2.5">
          {!editable ? (
            <p className="hint m-0 italic">
              {lockedReason ?? "Locked. This proposal is not editable in its current state."}
            </p>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-2.5 py-2 t-sm text-[var(--bad)]"
            >
              {error}
            </div>
          ) : null}

          {INTAKE_FIELD_SPECS.map((f) => {
            const id = `intake-${f.name}`;
            const value = draft[f.name] ?? "";
            const isEmpty = value.trim().length === 0;
            return (
              <div key={f.name}>
                <label className="field-label m-0" htmlFor={id}>
                  {FIELD_LABELS[f.name as IntakeField]}
                  {f.required ? <span className="text-[var(--bad)]"> *</span> : null}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    id={id}
                    className="textarea mt-1 w-full t-sm"
                    rows={Math.min(f.rows ?? 3, 4)}
                    value={value}
                    disabled={!editable || saving}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                  />
                ) : (
                  <input
                    id={id}
                    type={f.type}
                    className="input mt-1 w-full t-sm"
                    value={value}
                    disabled={!editable || saving}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                  />
                )}
                {isEmpty && !f.required ? (
                  <p className="hint m-0 mt-0.5 t-2xs">
                    Empty. This becomes a tracked gap rather than something the proposal invents.
                  </p>
                ) : null}
              </div>
            );
          })}

          {editable ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={save}
                disabled={!dirty || saving}
              >
                {saving ? "Saving…" : "Save details"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => {
                  setDraft({ ...intake });
                  setError(null);
                }}
              >
                Reset
              </button>
              <span className="ml-auto t-2xs text-[var(--muted)]">
                Rewrites nothing on their own
              </span>
            </div>
          ) : null}

          <p className="hint m-0">
            Saving updates the record and re-runs the checks. It does not rewrite any section, so
            a corrected figure reaches the document when you rewrite the section that uses it.
          </p>
        </div>
      ) : null}
    </section>
  );
}
