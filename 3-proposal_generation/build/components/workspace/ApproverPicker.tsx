"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AssignableApprover = {
  id: string;
  name: string;
  email: string;
  role: string;
};

/**
 * Choosing who should review this proposal.
 *
 * The firm's central control is that a DIFFERENT person approves, and until
 * now the app expressed that as a role and left the rest to whoever happened
 * to look. That works in a firm of three and stops working at ten: a proposal
 * submitted for approval went into a queue addressed to nobody, and the
 * failure mode is not a wrong decision, it is a client waiting a week while
 * two approvers each assume the other has it.
 *
 * What this sets is an INTENTION, not a permission. Any approver may still
 * act on any proposal, which is what stops one person's annual leave becoming
 * a blocked deal. The assignment says who is being asked.
 *
 * The author is absent from the list even when they hold the approver role,
 * because `assertCanApprove` would refuse them at the decision and a queue
 * entry that can never be actioned is worse than no entry at all.
 */
export function ApproverPicker({
  proposalId,
  approvers,
  assignedId,
  editable,
  approvedByName,
}: {
  proposalId: string;
  approvers: AssignableApprover[];
  assignedId: string | null;
  editable: boolean;
  /** Set once somebody has actually approved. Then the question is settled. */
  approvedByName: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(assignedId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(next: string) {
    const previous = value;
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/approver`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approverId: next === "" ? null : next }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || !payload.ok) {
        // Put the control back where it was. A picker that keeps a selection
        // the server refused is telling the user something untrue.
        setValue(previous);
        setError(payload.error?.message ?? "That could not be saved.");
        return;
      }
      router.refresh();
    } catch {
      setValue(previous);
      setError("That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (approvedByName) {
    return (
      <div className="rail-section">
        <div className="rail-title mb-1">Approved by</div>
        <p className="hint m-0">{approvedByName}</p>
      </div>
    );
  }

  const assigned = approvers.find((a) => a.id === assignedId) ?? null;

  if (!editable) {
    return (
      <div className="rail-section">
        <div className="rail-title mb-1">Approver</div>
        <p className="hint m-0">
          {assigned
            ? `Waiting on ${assigned.name}. Any approver may still act on it.`
            : "Not assigned. Any approver can pick this up."}
        </p>
      </div>
    );
  }

  return (
    <div className="rail-section">
      <div className="rail-title mb-1.5">Approver</div>

      {approvers.length === 0 ? (
        <p className="hint m-0">
          Nobody else can approve yet. An administrator adds approvers on the Team page.
        </p>
      ) : (
        <>
          <label className="sr-only" htmlFor="assigned-approver">
            Who should approve this proposal
          </label>
          <select
            id="assigned-approver"
            className="input w-full"
            value={value}
            disabled={busy}
            onChange={(e) => void assign(e.currentTarget.value)}
          >
            <option value="">Anyone available</option>
            {approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </select>
          <p className="hint mt-1.5">
            {busy
              ? "Saving…"
              : assigned
                ? `${assigned.name} will be asked, and copied on the email when it goes.`
                : "Optional. Any approver can pick it up, and the one who signs it off is copied on the client email."}
          </p>
        </>
      )}

      {error ? (
        <p role="alert" className="mt-1.5 t-xs text-[var(--bad)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
