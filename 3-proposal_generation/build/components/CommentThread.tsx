"use client";

import { useState } from "react";

/**
 * Review comments.
 *
 * The question this answers is the one a reviewer asks before they have made
 * up their mind: "where did the 40k come from?" Until this existed the only
 * way to ask it was to reject the whole proposal, because the sole feedback
 * field in the system hung off an approval DECISION. Rejecting to ask a
 * question resets the proposal and reads to the author as a verdict, so in
 * practice reviewers stop asking and start rubber-stamping — which defeats the
 * approval step entirely.
 *
 * Two deliberate restraints:
 *
 *   An unresolved comment BLOCKS NOTHING. Gaps are the gate; comments are a
 *   conversation. Letting any reader hold up an approval by leaving a question
 *   open would hand every viewer a veto, and would turn comments into the
 *   thing people avoid using.
 *
 *   Anyone who can see the proposal can comment, including an approver who
 *   cannot edit a word of it. That asymmetry is the feature: raising the
 *   question and acting on it are different jobs.
 */

export type CommentView = {
  id: string;
  sectionKey: string | null;
  body: string;
  authorName: string;
  resolved: boolean;
  resolverName: string | null;
  createdAt: string;
};

export function CommentThread({
  proposalId,
  initial,
  sectionKey = null,
  heading = "Review comments",
}: {
  proposalId: string;
  initial: CommentView[];
  /** When set, the thread is scoped to one section and posts are tagged with it. */
  sectionKey?: string | null;
  heading?: string;
}) {
  const [comments, setComments] = useState<CommentView[]>(initial);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const scoped = sectionKey ? comments.filter((c) => c.sectionKey === sectionKey) : comments;
  const open = scoped.filter((c) => !c.resolved);
  const resolved = scoped.filter((c) => c.resolved);

  async function post() {
    const body = draft.trim();
    if (body.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, sectionKey: sectionKey ?? undefined }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        comment?: CommentView;
        error?: { message: string };
      };
      if (!res.ok || !payload.ok || !payload.comment) {
        setError(payload.error?.message ?? "That comment could not be saved.");
        return;
      }
      setComments([...comments, payload.comment]);
      setDraft("");
    } catch {
      // The draft is deliberately NOT cleared, so a network failure does not
      // eat what somebody just typed.
      setError("Could not reach the server. Your comment was not saved, and it is still in the box.");
    } finally {
      setPending(false);
    }
  }

  async function setResolved(id: string, next: boolean) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/comments/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolved: next }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: { message: string } };
      if (!res.ok || !payload.ok) {
        setError(payload.error?.message ?? "That could not be saved.");
        return;
      }
      setComments(comments.map((c) => (c.id === id ? { ...c, resolved: next } : c)));
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rail-section">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="rail-title">{heading}</div>
        {open.length > 0 ? (
          <span className="badge badge-attention">
            <span aria-hidden="true" className="t-2xs">
              ●
            </span>
            {open.length} open
          </span>
        ) : null}
      </div>

      <p className="hint mt-0 mb-2.5">
        Questions and notes for the author. These do not block approval. Gaps are the
        gate; this is the conversation.
      </p>

      {error ? (
        <div
          role="alert"
          className="mb-2 rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-2.5 py-2 t-sm text-[var(--bad)]"
        >
          {error}
        </div>
      ) : null}

      {open.length === 0 && resolved.length === 0 ? (
        <p className="hint mt-0 mb-2.5">Nothing raised yet.</p>
      ) : null}

      <ul className="mb-2.5 flex list-none flex-col gap-1.5 p-0">
        {open.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            busy={busyId === c.id}
            onToggle={() => setResolved(c.id, true)}
            showSection={sectionKey === null}
          />
        ))}
      </ul>

      {resolved.length > 0 ? (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm mb-2 w-full justify-between"
            onClick={() => setShowResolved(!showResolved)}
            aria-expanded={showResolved}
          >
            <span>{resolved.length} resolved</span>
            <span aria-hidden="true">{showResolved ? "−" : "+"}</span>
          </button>
          {showResolved ? (
            <ul className="mb-2.5 flex list-none flex-col gap-1.5 p-0 opacity-65">
              {resolved.map((c) => (
                <CommentItem
                  key={c.id}
                  comment={c}
                  busy={busyId === c.id}
                  onToggle={() => setResolved(c.id, false)}
                  showSection={sectionKey === null}
                />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/*
        The composer carried `className="field"`, and there is no `.field`
        rule in the stylesheet — so this was a raw browser textarea sitting
        in the middle of a designed panel, with the wrong font, the wrong
        border and no focus ring. Two of its siblings had the same problem:
        `var(--line)` and `.badge-neutral` are also names that do not exist.
        A class name that never matched fails silently, which is why all
        three survived this long.
      */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2">
        <label className="sr-only" htmlFor={`comment-${sectionKey ?? "all"}`}>
          Add a comment
        </label>
        <textarea
          id={`comment-${sectionKey ?? "all"}`}
          className="textarea min-h-[68px] w-full resize-y t-sm"
          placeholder={
            sectionKey
              ? "Ask about this section…"
              : "Ask a question, or leave a note for the author…"
          }
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Send on ⌘/Ctrl+Enter. Plain Enter stays a newline: a comment
            // is often two sentences, and losing the second one to a stray
            // keystroke is how people stop leaving comments.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void post();
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending || draft.trim().length === 0}
            onClick={post}
          >
            {pending ? "Posting…" : "Post comment"}
          </button>
          <span className="ml-auto t-2xs text-[var(--muted)]">
            {draft.trim().length === 0 ? (
              "Visible to everyone on this proposal"
            ) : (
              <>
                <span className="kbd">⌘</span>
                <span className="kbd ml-0.5">↵</span> to post
              </>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}

function CommentItem({
  comment,
  busy,
  onToggle,
  showSection,
}: {
  comment: CommentView;
  busy: boolean;
  onToggle: () => void;
  showSection: boolean;
}) {
  return (
    <li className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 t-xs text-[var(--muted)]">
        <strong className="font-semibold text-[var(--ink-2)]">{comment.authorName}</strong>
        {showSection && comment.sectionKey ? (
          <span className="badge">{comment.sectionKey.replace(/_/g, " ")}</span>
        ) : null}
        {comment.resolved && comment.resolverName ? (
          <span>· resolved by {comment.resolverName}</span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm ml-auto"
          disabled={busy}
          onClick={onToggle}
        >
          {busy ? "…" : comment.resolved ? "Reopen" : "Mark resolved"}
        </button>
      </div>
      <p className="m-0 whitespace-pre-wrap t-base leading-[1.5] text-[var(--ink)]">
        {comment.body}
      </p>
    </li>
  );
}
