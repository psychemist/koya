"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CorrelationChip } from "../../../../components/ui";

/**
 * Undoing an approval, from the page where it was given.
 *
 * `assertCanWithdraw` has always permitted this - an approver may recall an
 * approved proposal, because approving the wrong version is a mistake an
 * approver makes and should be able to undo. The control only existed in the
 * workspace, so an approver who realised immediately after clicking Approve
 * was told on this page that there was "no decision to make" and had to go
 * looking for somewhere else to undo it. A permission nobody can find is not
 * a permission.
 *
 * Deliberately not styled as a primary action. Recalling is the rarer path
 * and it invalidates a client link, so it should take a moment's thought
 * rather than sit under the thumb.
 */
export function RecallPanel({
  proposalId,
  isAuthor,
}: {
  proposalId: string;
  /** The author sees a different sentence: nobody else approved this. */
  isAuthor: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId?: string } | null>(null);

  async function recall() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/withdraw`, { method: "POST" });
      const payload = (await res.json()) as {
        ok?: boolean;
        correlationId?: string;
        error?: { message?: string };
      };
      if (!res.ok || !payload.ok) {
        setError({
          message: payload.error?.message ?? "The approval could not be recalled.",
          correlationId: payload.correlationId,
        });
        return;
      }
      router.refresh();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "The approval could not be recalled." });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="panel p-5">
      <h2 className="panel-title mb-1.5">Recall this approval</h2>
      <p className="hint m-0 max-w-[68ch]">
        {isAuthor
          ? "This proposal is approved and has not been sent. Recalling it returns it to review so you can edit it, and it will need approving again before it can go out."
          : "Approved the wrong version, or spotted something after signing it off? Recalling returns it to the salesperson for changes. It will need approving again before it can be sent."}{" "}
        The client link stops working immediately.
      </p>

      {error ? (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-3 py-2 t-base text-[var(--bad)]"
        >
          <span aria-hidden="true">■</span>
          <span className="flex-1">{error.message}</span>
          {error.correlationId ? <CorrelationChip id={error.correlationId} /> : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-attention-soft"
              disabled={busy}
              onClick={recall}
            >
              {busy ? "Recalling…" : "Yes, recall it"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it approved
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
            Recall approval
          </button>
        )}
      </div>
    </div>
  );
}
