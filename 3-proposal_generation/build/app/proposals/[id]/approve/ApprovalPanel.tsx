"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CorrelationChip } from "../../../../components/ui";
import type { GapView } from "../../../../components/workspace/GapPanel";

/**
 * The approver's decision.
 *
 * The Approve button is disabled while a blocking gap is open, and the server
 * refuses it too. Both matter: the disabled button explains, the server
 * enforces. Disabling alone would be a suggestion, and enforcing alone would
 * be a mystery.
 *
 * Requesting changes requires a note. An approver who sends something back
 * without saying why has moved the work without moving it forward.
 */
export function ApprovalPanel({
  proposalId,
  blockingGaps,
  waivedGaps,
  canApprove,
  refusalReason,
}: {
  proposalId: string;
  blockingGaps: GapView[];
  waivedGaps: GapView[];
  canApprove: boolean;
  refusalReason: string | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; correlationId?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const blocked = blockingGaps.length > 0;

  async function decide(decision: "approved" | "changes_requested") {
    if (decision === "changes_requested" && note.trim().length < 5) {
      setError({ message: "Say what needs changing. The salesperson has to know what to fix." });
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: { message: string; correlationId: string };
      };
      if (!res.ok || !payload.ok) {
        setError({
          message: payload.error?.message ?? "That decision could not be recorded.",
          correlationId: payload.error?.correlationId,
        });
        return;
      }
      setDone(
        decision === "approved"
          ? "Approved. It can now be delivered to the client."
          : "Sent back for changes. The salesperson can edit it again.",
      );
      router.refresh();
    } catch {
      setError({ message: "Could not reach the server. Nothing was recorded." });
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--good-line)] bg-[var(--good-soft)] px-3 py-2.5 t-base text-[var(--good)]">
        <span aria-hidden="true">● </span>
        {done}
      </div>
    );
  }

  if (!canApprove) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--attention-line)] bg-[var(--attention-soft)] px-3 py-2.5 t-base text-[var(--attention)]">
        <span aria-hidden="true">▲ </span>
        {refusalReason ?? "You cannot approve this proposal."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-3 py-2 t-base text-[var(--bad)]"
        >
          <span aria-hidden="true">■</span>
          <span className="flex-1">{error.message}</span>
          {error.correlationId ? <CorrelationChip id={error.correlationId} /> : null}
        </div>
      ) : null}

      {blocked ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--attention-line)] bg-[var(--attention-soft)] px-3 py-2.5 t-sm text-[var(--attention)]">
          <div className="font-semibold">
            <span aria-hidden="true">▲ </span>
            {blockingGaps.length} blocking gap{blockingGaps.length === 1 ? "" : "s"} must be
            settled first
          </div>
          <ul className="mt-1.5 flex flex-col gap-1 pl-4">
            {blockingGaps.map((g) => (
              <li key={g.id}>{g.message}</li>
            ))}
          </ul>
          <p className="m-0 mt-2">
            Either the salesperson resolves them, or you waive each one with a written reason
            from the workspace. Approving around them is not possible.
          </p>
        </div>
      ) : null}

      {waivedGaps.length > 0 ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 t-sm">
          <div className="eyebrow">
            {waivedGaps.length} waived gap{waivedGaps.length === 1 ? "" : "s"}, read these
            before approving
          </div>
          <ul className="mt-1.5 flex flex-col gap-2">
            {waivedGaps.map((g) => (
              <li key={g.id}>
                <div className="text-[var(--ink)]">{g.message}</div>
                {g.waiverReason ? (
                  <div className="mt-0.5 border-l-2 border-[var(--attention-line)] pl-2 italic text-[var(--ink-2)]">
                    {g.waiverReason}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <label className="field-label" htmlFor="approval-note">
          Note {blocked ? "" : "(required to request changes)"}
        </label>
        <textarea
          id="approval-note"
          className="textarea min-h-[90px]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the salesperson should know, or what needs changing."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-good"
          onClick={() => decide("approved")}
          disabled={blocked || Boolean(busy)}
          title={blocked ? "Blocking gaps are still open" : undefined}
        >
          {busy === "approved" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => decide("changes_requested")}
          disabled={Boolean(busy)}
        >
          {busy === "changes_requested" ? "Sending back…" : "Request changes"}
        </button>
        <span className="hint m-0">
          Approving does not send anything. Delivery is a separate, deliberate step.
        </span>
      </div>
    </div>
  );
}
