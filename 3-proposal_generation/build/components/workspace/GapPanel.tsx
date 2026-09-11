"use client";

import { useEffect, useState } from "react";
import { Caret } from "../ui";

/**
 * The gap panel.
 *
 * This is where the missing-information requirement becomes something a person
 * acts on. Two things it does deliberately:
 *
 *   It distinguishes resolve from waive, and makes waive cost something. A
 *   waiver needs at least ten characters of reason, enforced here, in the
 *   route handler, and by a CHECK constraint in the database. An unexplained
 *   waiver is indistinguishable from clicking through a warning.
 *
 *   It shows who found each gap. "A rule found this" and "Claude found this
 *   while writing" carry different weight to a reviewer deciding whether to
 *   waive, so the provenance is on the chip rather than hidden.
 *
 * STATE IS PER GAP, NOT PER PANEL. The first version held one `reason` string
 * for the whole list, which meant opening the waive box on a second gap
 * inherited whatever had been typed against the first. A waiver is a written
 * justification that goes into an audit trail and is read later by someone
 * deciding whether to trust the document, so text leaking between two of them
 * is not a cosmetic bug: it produces a signed reason that belongs to a
 * different finding.
 *
 * AND THE SERVER IS THE AUTHORITY. Every action reconciles the whole list
 * from the API rather than patching the one row locally. Local patching left
 * the panel stuck whenever the two disagreed — a waiver that had actually
 * been recorded still showing as open, with no way back except performing a
 * different action on it. Refetching costs one request on an action a person
 * takes a handful of times per proposal, and removes the entire class.
 */

export type GapView = {
  id: string;
  sectionKey: string | null;
  field: string | null;
  severity: "blocking" | "advisory";
  message: string;
  detectedBy: "validator" | "model" | "grounding" | "scanner" | "style";
  status: "open" | "resolved" | "waived";
  waiverReason: string | null;
};

const SOURCE_LABEL: Record<GapView["detectedBy"], string> = {
  validator: "rule",
  model: "Claude",
  grounding: "figure check",
  scanner: "upload scan",
  style: "voice",
};

const MIN_REASON = 10;

export function GapPanel({
  proposalId,
  gaps,
  onChange,
  canAct,
  onJump,
  lockedReason,
}: {
  proposalId: string;
  gaps: GapView[];
  onChange: (gaps: GapView[]) => void;
  canAct: boolean;
  /**
   * Scrolls the document to a section. Optional, because the panel is also
   * rendered on the approval page, where there is no document to scroll.
   */
  onJump?: (sectionKey: string) => void;
  /**
   * Why the buttons are absent, when they are.
   *
   * Controls that simply vanish read as a bug. They vanished here for a good
   * reason (the proposal is locked, or this reader may not act on it) and
   * saying so costs one line.
   */
  lockedReason?: string | null;
}) {
  const [waiving, setWaiving] = useState<string | null>(null);
  /** Keyed by gap id. One draft reason per finding, never shared. */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const reasonFor = (gapId: string) => reasons[gapId] ?? "";
  const setReasonFor = (gapId: string, value: string) =>
    setReasons((prev) => ({ ...prev, [gapId]: value }));
  const clearReason = (gapId: string) =>
    setReasons((prev) => {
      const next = { ...prev };
      delete next[gapId];
      return next;
    });

  const open = gaps.filter((g) => g.status === "open");

  /**
   * Forget the draft reason for any gap that is no longer open.
   *
   * A waiver is not the only way a blocker goes away. Rewriting the section,
   * editing it by hand, or filling in the intake field all resolve one, and
   * the gate closes it on the next run. When that happens while somebody has
   * the waive box open with half a justification typed into it, both the box
   * and the text used to survive: the row vanished from the list, but the
   * state behind it did not, so the text reappeared if the gap was ever
   * reopened, attached to a finding it was never written about.
   *
   * That is the same defect as the reason field being shared across gaps,
   * arriving by a different route, and it matters for the same reason: what
   * gets written here is signed and read later by whoever is deciding
   * whether to trust the document.
   */
  useEffect(() => {
    const openIds = new Set(gaps.filter((g) => g.status === "open").map((g) => g.id));
    setReasons((prev) => {
      const stale = Object.keys(prev).filter((id) => !openIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
    setWaiving((current) => (current !== null && !openIds.has(current) ? null : current));
  }, [gaps]);
  const closed = gaps.filter((g) => g.status !== "open");
  const blocking = open.filter((g) => g.severity === "blocking");

  /** Pulls the authoritative list, so the panel can never argue with the API. */
  async function reconcile(): Promise<boolean> {
    try {
      const res = await fetch(`/api/proposals/${proposalId}/gaps`, { cache: "no-store" });
      if (!res.ok) return false;
      const payload = (await res.json()) as { gaps?: GapView[] };
      if (!payload.gaps) return false;
      onChange(payload.gaps);
      return true;
    } catch {
      return false;
    }
  }

  async function act(gapId: string, action: "resolve" | "waive" | "reopen", why?: string) {
    // One decision at a time. Two in flight against the same list is how the
    // panel used to end up displaying a row the server had already closed.
    if (pending) return;
    setPending(gapId);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/gaps/${gapId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: why }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        gap?: GapView;
        error?: { message: string };
      };
      if (!res.ok || !payload.ok || !payload.gap) {
        setError(payload.error?.message ?? "That could not be saved.");
        /**
         * The request failed, and the reason might be that this gap has
         * already moved — someone else acted on it, or a re-run of the gates
         * closed it. Refetch before deciding the panel is right and the
         * server is wrong.
         */
        await reconcile();
        return;
      }
      onChange(gaps.map((g) => (g.id === gapId ? payload.gap! : g)));
      setWaiving(null);
      clearReason(gapId);
      // The write succeeded; a background refresh keeps the rest of the list
      // honest without blocking the interaction that just completed.
      void reconcile();
    } catch {
      setError("Could not reach the server. Nothing was changed.");
      await reconcile();
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rail-section">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="rail-title">Gaps</div>
        {blocking.length > 0 ? (
          <span className="badge badge-attention">
            <span aria-hidden="true" className="t-2xs">
              ▲
            </span>
            {blocking.length} blocking
          </span>
        ) : open.length === 0 ? (
          <span className="badge badge-good">
            <span aria-hidden="true" className="t-2xs">
              ✓
            </span>
            clear
          </span>
        ) : null}
      </div>

      <p className="hint mt-0 mb-2.5">
        {blocking.length > 0
          ? "Blocking gaps must be resolved, or waived with a reason, before this can be approved."
          : "Anything the system could not support from the intake or the attachments."}
      </p>

      {error ? (
        <div
          role="alert"
          className="mb-2 rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-2.5 py-2 t-sm text-[var(--bad)]"
        >
          {error}
        </div>
      ) : null}

      {open.length === 0 ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--good-line)] bg-[var(--good-soft)] px-2.5 py-2 t-sm text-[var(--good)]">
          No open gaps. Every figure in the document was found in the intake or an attachment.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {open
            .slice()
            .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1))
            .map((gap) => (
              <li
                key={gap.id}
                className={`rounded-[var(--radius-sm)] border px-2.5 py-2 t-sm ${
                  gap.severity === "blocking"
                    ? "border-[var(--attention-line)] bg-[var(--attention-soft)]"
                    : "border-[var(--border)] bg-[var(--surface-2)]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span aria-hidden="true" className="t-2xs">
                    {gap.severity === "blocking" ? "▲" : "·"}
                  </span>
                  <span className="t-2xs font-bold uppercase tracking-wide">
                    {gap.severity === "blocking" ? "Blocks approval" : "Advisory"}
                  </span>
                  <span className="ml-auto t-2xs text-[var(--muted)]">
                    found by {SOURCE_LABEL[gap.detectedBy]}
                  </span>
                </div>

                <p className="m-0 mt-1.5 leading-relaxed text-[var(--ink)]">{gap.message}</p>

                {gap.sectionKey ? (
                  onJump ? (
                    <button
                      type="button"
                      className="mt-1 inline-flex items-center gap-1 t-2xs text-[var(--accent)] hover:underline"
                      onClick={() => onJump(gap.sectionKey!)}
                      title="Scroll the document to this section"
                    >
                      in {gap.sectionKey.replace(/_/g, " ")}
                      <span aria-hidden="true">&rsaquo;</span>
                    </button>
                  ) : (
                    <p className="m-0 mt-1 t-2xs text-[var(--muted)]">
                      in {gap.sectionKey.replace(/_/g, " ")}
                    </p>
                  )
                ) : null}

                {!canAct && lockedReason ? (
                  <p className="m-0 mt-2 t-2xs italic text-[var(--muted)]">
                    {lockedReason}
                  </p>
                ) : null}

                {canAct ? (
                  waiving === gap.id ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <label className="field-label m-0" htmlFor={`reason-${gap.id}`}>
                        Why is it acceptable to proceed?
                      </label>
                      <textarea
                        id={`reason-${gap.id}`}
                        className="textarea min-h-[64px] t-sm"
                        value={reasonFor(gap.id)}
                        onChange={(e) => setReasonFor(gap.id, e.target.value)}
                        placeholder="e.g. Client confirmed the rate by phone after the call; contract will carry the figure."
                        disabled={pending === gap.id}
                        autoFocus
                      />
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="btn btn-sm btn-attention-soft"
                          disabled={
                            reasonFor(gap.id).trim().length < MIN_REASON || pending !== null
                          }
                          onClick={() => act(gap.id, "waive", reasonFor(gap.id))}
                        >
                          {pending === gap.id ? "Saving…" : "Waive with this reason"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={pending === gap.id}
                          onClick={() => {
                            setWaiving(null);
                            clearReason(gap.id);
                          }}
                        >
                          Cancel
                        </button>
                        <span className="ml-auto t-2xs text-[var(--muted)]">
                          {reasonFor(gap.id).trim().length < MIN_REASON
                            ? `${MIN_REASON - reasonFor(gap.id).trim().length} more characters`
                            : "recorded in the audit trail"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm btn-good-soft"
                        disabled={pending !== null}
                        onClick={() => act(gap.id, "resolve")}
                        title="The underlying problem is fixed. The check will confirm on the next run, and the gap reopens if it is not."
                      >
                        {pending === gap.id ? "Saving…" : "Resolved"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-attention-soft"
                        disabled={pending !== null}
                        onClick={() => setWaiving(gap.id)}
                      >
                        Waive…
                      </button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
        </ul>
      )}

      {closed.length > 0 ? (
        <div className="mt-2.5">
          <button
            type="button"
            className="disclosure t-sm text-[var(--ink-2)]"
            onClick={() => setShowClosed((v) => !v)}
            aria-expanded={showClosed}
          >
            <span>
              {closed.length} closed ({closed.filter((g) => g.status === "waived").length} waived)
            </span>
            <Caret />
          </button>

          {showClosed ? (
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {closed.map((gap) => (
                <li
                  key={gap.id}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-2 t-xs text-[var(--ink-2)]"
                >
                  <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="t-2xs">
                      {gap.status === "waived" ? "◇" : "✓"}
                    </span>
                    <span className="font-semibold uppercase tracking-wide">{gap.status}</span>
                    {canAct ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm ml-auto"
                        onClick={() => act(gap.id, "reopen")}
                        disabled={pending !== null}
                      >
                        Reopen
                      </button>
                    ) : null}
                  </div>
                  <p className="m-0 mt-1">{gap.message}</p>
                  {gap.waiverReason ? (
                    <p className="m-0 mt-1 border-l-2 border-[var(--attention-line)] pl-2 italic">
                      {gap.waiverReason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
