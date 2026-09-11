"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CorrelationChip } from "../../../../components/ui";

/**
 * The delivery step.
 *
 * The covering email is editable before it goes. It arrives pre-written from
 * the template — no model call, because it is five lines with three
 * substitutions — but a salesperson who has just spoken to the client often
 * wants to add a sentence, and forcing them to send a generic note would mean
 * they send it from Outlook instead and the system loses the record.
 *
 * Editing the body changes the idempotency key, deliberately: the client would
 * be receiving different words, so it is a genuine second send rather than a
 * duplicate to suppress.
 */

type LaneAttempt = { lane: string; ok: boolean; detail: string; latencyMs: number };

type Result = {
  status: "sent" | "failed" | "blocked";
  channel: string;
  message: string;
  needsManualSend: boolean;
  attempts: LaneAttempt[];
};

export function DeliverPanel({
  proposalId,
  recipient,
  subject: initialSubject,
  bodyText: initialBody,
  proposalLink,
  linkIsFinal,
  alreadySent,
  restoredFromLastSend = false,
  lastNoteWasStale = false,
  approverEmail = null,
  lanes,
}: {
  proposalId: string;
  recipient: string;
  subject: string;
  bodyText: string;
  proposalLink: string;
  linkIsFinal: boolean;
  alreadySent: boolean;
  /** The note below is the one last sent, not a freshly rendered template. */
  restoredFromLastSend?: boolean;
  /**
   * A previous note existed but was written against client details that have
   * since changed, so it was discarded rather than offered back.
   */
  lastNoteWasStale?: boolean;
  /** Copied on the send. The approver who signed it off, when there is one. */
  approverEmail?: string | null;
  lanes: { n8n: boolean; resend: boolean };
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(initialSubject);
  const [bodyText, setBodyText] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<{ message: string; correlationId?: string } | null>(null);
  /**
   * The confirmation step.
   *
   * Sending is the one irreversible action in the product: a client reads it,
   * and no amount of permission makes that untrue afterwards. Everything else
   * here can be undone - a proposal recalled, an approval withdrawn, a
   * section reverted - so this is the single place a second press is worth
   * asking for. It also puts the four things worth checking on one screen,
   * which is not otherwise true: the address, who else gets a copy, the
   * subject, and the first lines of what they will read.
   */
  const [confirming, setConfirming] = useState(false);

  const noProvider = !lanes.n8n && !lanes.resend;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, bodyText }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        delivery?: Result;
        error?: { message: string; correlationId: string };
      };
      if (!res.ok || !payload.ok || !payload.delivery) {
        setError({
          message: payload.error?.message ?? "The send could not be completed.",
          correlationId: payload.error?.correlationId,
        });
        return;
      }
      setResult(payload.delivery);
      router.refresh();
    } catch {
      setError({
        message:
          "Could not reach the server. Nothing was sent, and the delivery record will show no attempt.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {noProvider ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--attention-line)] bg-[var(--attention-soft)] px-3 py-2.5 t-sm text-[var(--attention)]">
          <span aria-hidden="true">▲ </span>
          <strong>No email provider is configured.</strong> Sending will record the attempt and
          hand you a ready-to-send <code>.eml</code> file rather than claiming to have
          delivered it. The proposal link below works either way.
        </div>
      ) : null}

      {alreadySent ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--good-line)] bg-[var(--good-soft)] px-3 py-2.5 t-sm text-[var(--good)]">
          <span aria-hidden="true">● </span>
          This proposal has already been sent, and the document itself is now frozen. You
          can still send again: change the recipient, the subject or the note below and it
          goes as a genuine second send. Press send without changing any of them and nothing
          is sent twice, you will be told it was suppressed rather than shown an error.
        </div>
      ) : null}

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

      {result ? (
        <div
          className={`rounded-[var(--radius-sm)] border px-3 py-2.5 t-sm ${
            result.status === "sent"
              ? "border-[var(--good-line)] bg-[var(--good-soft)] text-[var(--good)]"
              : "border-[var(--attention-line)] bg-[var(--attention-soft)] text-[var(--attention)]"
          }`}
        >
          <div className="font-semibold">
            <span aria-hidden="true">{result.status === "sent" ? "● " : "▲ "}</span>
            {result.message}
          </div>

          {result.attempts.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {result.attempts.map((a, i) => (
                <li key={i} className="mono t-xs">
                  {a.ok ? "✓" : "✗"} {a.lane} · {a.latencyMs}ms · {a.detail}
                </li>
              ))}
            </ul>
          ) : null}

          {result.needsManualSend ? (
            <a
              href={`/api/proposals/${proposalId}/eml`}
              className="btn btn-sm mt-2 no-underline hover:no-underline"
            >
              Download the email (.eml)
            </a>
          ) : null}
        </div>
      ) : null}

      <div>
        <label className="field-label" htmlFor="recipient">
          To
        </label>
        <input id="recipient" className="input" value={recipient} readOnly aria-readonly="true" />
        <div className="hint">
          Taken from the intake. Change it in the workspace if it is wrong.
        </div>
      </div>

      <div>
        <label className="field-label" htmlFor="subject">
          Subject
        </label>
        <input
          id="subject"
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div>
        <label className="field-label" htmlFor="bodyText">
          Message
        </label>
        <textarea
          id="bodyText"
          className="textarea min-h-[240px] t-base leading-relaxed"
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
        />
        <div className="hint">
          {restoredFromLastSend
            ? "This is the note you sent last time, brought back so a second send starts where you left off rather than from the template. "
            : ""}
          {lastNoteWasStale
            ? "Your earlier note was written before the client details changed, so it has been replaced with a fresh draft rather than offered back with the old name on it. "
            : ""}
          Edit it if you want to. <code>{"{{proposal_link}}"}</code> is replaced with the real
          link when you send, so keep it wherever you want the link to appear. Delete it and the
          link is added at the end rather than left out.
        </div>
      </div>

      {/*
        WHAT THE CLIENT ACTUALLY GETS.
        
        This section used to be a read-only input labelled "Proposal link"
        that, before a link existed, displayed the string
        "https://…/p/… (issued on send)". A URL-shaped box containing
        something that is not a URL invites exactly one question, which is
        whether a link is being sent at all, and the answer was buried in a
        hint below it. So the box only appears when there is a real link in
        it, and what arrives at the other end is spelled out instead.
      */}
      <div>
        <div className="field-label">What the client receives</div>
        <ul className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0 t-sm text-[var(--ink-2)]">
          <li className="flex gap-2">
            <span aria-hidden="true" className="mt-[3px] t-2xs text-[var(--good)]">
              ●
            </span>
            <span>
              <strong className="font-semibold text-[var(--ink)]">The email above</strong>, with a
              link to a read-only web copy of the proposal in it. The link needs no sign-in,
              expires after 60 days, and can be revoked.
            </span>
          </li>
          <li className="flex gap-2">
            <span
              aria-hidden="true"
              className={`mt-[3px] t-2xs ${lanes.resend ? "text-[var(--good)]" : "text-[var(--muted)]"}`}
            >
              {lanes.resend ? "●" : "○"}
            </span>
            <span>
              <strong className="font-semibold text-[var(--ink)]">The PDF, attached</strong>
              {lanes.resend
                ? lanes.n8n
                  ? ", if it goes out through Resend. The n8n workflow sends the link only, and fetches the document from that link itself rather than carrying megabytes of attachment through a webhook."
                  : ". Resend attaches it to the message."
                : ". Not configured, so nothing is attached: the link is how the client reads it."}
            </span>
          </li>
        </ul>
      </div>

      {linkIsFinal ? (
        <div>
          <label className="field-label" htmlFor="link">
            The link that will be sent
          </label>
          <input id="link" className="input mono t-sm" value={proposalLink} readOnly />
        </div>
      ) : (
        <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 t-sm text-[var(--ink-2)]">
          The link is issued when you press send, and it is put into the email for you. It is not
          shown here beforehand because the database keeps only a hash of it, so an existing link
          cannot be reprinted: that is what stops a copy of the database handing somebody a set of
          live client proposals.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-good btn-lg"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {busy ? "Sending…" : alreadySent ? "Send again" : "Send to client"}
        </button>
        <span className="hint m-0">
          {lanes.n8n
            ? "Goes via the n8n workflow, falling back to Resend if it does not answer."
            : lanes.resend
              ? "Goes via Resend."
              : "Records the attempt and gives you the file to send."}
        </span>
      </div>

      {confirming ? (
        <ConfirmSend
          recipient={recipient}
          approverEmail={approverEmail}
          subject={subject}
          bodyText={bodyText}
          alreadySent={alreadySent}
          noProvider={noProvider}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void send();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The last screen before a client reads it.
 *
 * A dialog rather than an inline expander, because the point is to interrupt.
 * An inline confirmation sits in the same visual flow as the form above it
 * and gets clicked through as part of the same gesture, which is the failure
 * mode this exists to prevent.
 *
 * Focus moves to Cancel rather than to the confirm button. A dialog that
 * opens with the destructive action focused turns a stray Enter keypress -
 * the very keypress that was probably still travelling from the form - into
 * a sent email.
 */
function ConfirmSend({
  recipient,
  approverEmail,
  subject,
  bodyText,
  alreadySent,
  noProvider,
  busy,
  onCancel,
  onConfirm,
}: {
  recipient: string;
  approverEmail: string | null;
  subject: string;
  bodyText: string;
  alreadySent: boolean;
  noProvider: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const preview = bodyText.trim().split("\n").filter(Boolean).slice(0, 3).join("\n");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,11,14,0.55)] p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-send-title"
        className="panel max-h-[85vh] w-full max-w-[540px] overflow-y-auto p-5"
      >
        <h2 id="confirm-send-title" className="panel-title">
          {alreadySent ? "Send this again?" : "Send this to the client?"}
        </h2>
        <p className="hint mt-1.5">
          {noProvider
            ? "No email provider is configured, so this records the attempt and hands you a file to send yourself. Nothing leaves the building."
            : "This goes to a client and cannot be taken back."}
        </p>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 t-sm">
          <dt className="eyebrow">To</dt>
          <dd className="m-0 font-medium text-[var(--ink)]">{recipient}</dd>

          <dt className="eyebrow">Copy</dt>
          <dd className="m-0 text-[var(--ink-2)]">
            {approverEmail ?? <span className="text-[var(--muted)]">nobody</span>}
          </dd>

          <dt className="eyebrow">Subject</dt>
          <dd className="m-0 text-[var(--ink-2)]">{subject}</dd>
        </dl>

        <div className="mt-4">
          <div className="eyebrow mb-1.5">Opens with</div>
          <p className="mono m-0 whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 t-xs leading-relaxed text-[var(--ink-2)]">
            {preview}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-good" onClick={onConfirm} disabled={busy}>
            {busy ? "Sending…" : noProvider ? "Record it and give me the file" : "Yes, send it"}
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <span className="hint m-0 ml-auto">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
