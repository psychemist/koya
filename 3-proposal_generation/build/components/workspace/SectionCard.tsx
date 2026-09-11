"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentBody, SectionSkeleton, StreamingBody, type CitationTarget } from "../DocumentBody";
import { Badge } from "../ui";
import type { SectionView } from "./Workspace";
import type { GapView } from "./GapPanel";

/**
 * One section of the document, with its controls attached to it.
 *
 * WHY THIS EXISTS. Editing and regeneration used to live in the right-hand
 * rail, operating on whichever section had last been clicked. Three things
 * were wrong with that, and they were all reported by the first person to use
 * it properly:
 *
 *   The controls were hard to find. Nothing about a paragraph of a document
 *   suggests that clicking it changes what a panel on the other side of the
 *   screen will do, so the two most-used actions in the application were
 *   effectively hidden behind an undiscoverable selection step.
 *
 *   Only one section could be worked on. A single `editing` flag in a single
 *   panel means opening the pricing editor closes the introduction editor,
 *   and any unsaved text in it goes with it.
 *
 *   Nothing survived a refresh. Text typed into the editor, and the
 *   instruction typed into the rewrite box, lived only in React state. A
 *   reload, a crashed tab, or a laptop closing lost both without warning —
 *   including the instruction that had just been used to produce a draft,
 *   which is precisely the thing a person wants back.
 *
 * So the controls come to the section, each section owns its own state, and
 * that state is mirrored into `localStorage` on every keystroke.
 *
 * WHAT IS DELIBERATELY NOT PERSISTED ANYWHERE BUT THIS BROWSER. The draft is
 * client text about a client's business. It goes into `localStorage` under a
 * key scoped to the proposal, and it is deleted the moment it is saved to the
 * server or explicitly discarded. It is never sent anywhere except the save
 * request the person asked for.
 */

type Notice = {
  tone: "good" | "bad" | "neutral";
  message: string;
  correlationId?: string | null;
};

type HistoryEntry = {
  version: number;
  origin: string;
  instruction: string | null;
  actorName: string | null;
  createdAt: string;
  body: string;
};

const ORIGIN_LABEL: Record<string, string> = {
  ai_draft: "Claude, full draft",
  ai_regeneration: "Claude, rewritten",
  human_edit: "Edited by hand",
  revert: "Restored",
};

/**
 * A section counts as "recently touched" for a couple of minutes after it
 * changes, which is how long its controls stay open without being hovered.
 * Long enough to act on what just arrived, short enough that a document left
 * on screen settles back into being a document.
 */
const RECENT_MS = 120_000;

type StoredDraft = {
  /** The section version this draft was started from. */
  base: number;
  body: string | null;
  instruction: string;
  at: number;
};

function draftKey(proposalId: string, sectionKey: string): string {
  return `koya:draft:${proposalId}:${sectionKey}`;
}

function readDraft(key: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.base !== "number") return null;
    return {
      base: parsed.base,
      body: typeof parsed.body === "string" ? parsed.body : null,
      instruction: typeof parsed.instruction === "string" ? parsed.instruction : "",
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    // Private mode, disabled storage, or corrupted JSON. Losing a recovery
    // copy is survivable; throwing on render is not.
    return null;
  }
}

function writeDraft(key: string, draft: StoredDraft): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota, or storage switched off. The editor keeps working in memory.
  }
}

function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

export function SectionCard({
  proposalId,
  section,
  sources,
  gaps,
  editable,
  selected,
  onSelect,
  streamingText,
  isGenerating,
  documentBusy,
  onBody,
  onNotice,
  onGaps,
  onCost,
  registerRef,
  lockedReason,
}: {
  proposalId: string;
  section: SectionView;
  sources: readonly CitationTarget[];
  gaps: readonly GapView[];
  editable: boolean;
  selected: boolean;
  onSelect: () => void;
  streamingText: string | undefined;
  isGenerating: boolean;
  /** True while a whole-document operation owns the proposal. */
  documentBusy: boolean;
  onBody: (body: string) => void;
  onNotice: (notice: Notice) => void;
  onGaps: () => void;
  onCost: (label: string) => void;
  registerRef: (el: HTMLElement | null) => void;
  /** Shown in place of the controls when this section cannot be worked on. */
  lockedReason?: string | null;
}) {
  const storageKey = draftKey(proposalId, section.key);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.bodyMd);
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<"regen" | "save" | "revert" | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [touchedAt, setTouchedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  const hydrated = useRef(false);

  /**
   * Recovery, once, on mount.
   *
   * A stored draft is only offered when it was taken from the version of the
   * section that is on screen now. If the section has moved on since — a
   * colleague edited it, or a full regeneration replaced it — restoring the
   * old text would silently overwrite work that is newer, so the copy is
   * dropped and the person is told rather than asked.
   */
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;

    const stored = readDraft(storageKey);
    if (!stored) return;

    if (stored.base !== section.version) {
      clearDraft(storageKey);
      if (stored.body !== null && stored.body !== section.bodyMd) {
        onNotice({
          tone: "neutral",
          message: `An unsaved draft of ${section.heading} was found, but the section has changed since. The newer text is shown; the draft was discarded.`,
        });
      }
      return;
    }

    if (stored.instruction.trim().length > 0) setInstruction(stored.instruction);
    if (stored.body !== null && stored.body !== section.bodyMd) {
      setDraft(stored.body);
      setEditing(true);
      setRecovered(true);
    }
  }, [onNotice, section.bodyMd, section.heading, section.version, storageKey]);

  /** Mirror both text boxes to storage on every keystroke. */
  useEffect(() => {
    if (!hydrated.current) return;
    const dirty = editing && draft !== section.bodyMd;
    if (!dirty && instruction.trim().length === 0) {
      clearDraft(storageKey);
      return;
    }
    writeDraft(storageKey, {
      base: section.version,
      body: dirty ? draft : null,
      instruction,
      at: Date.now(),
    });
  }, [draft, editing, instruction, section.bodyMd, section.version, storageKey]);

  /** Server text wins whenever it changes and the person is not mid-edit. */
  useEffect(() => {
    if (!editing) setDraft(section.bodyMd);
  }, [editing, section.bodyMd]);

  const markTouched = useCallback(() => setTouchedAt(Date.now()), []);

  /** Retires the "recent" state on its own, so the shell settles down. */
  useEffect(() => {
    if (touchedAt === null) return;
    const timer = window.setTimeout(() => forceTick((n) => n + 1), RECENT_MS);
    return () => window.clearTimeout(timer);
  }, [touchedAt]);

  const isStreaming = streamingText !== undefined;
  const isRecent = touchedAt !== null && Date.now() - touchedAt < RECENT_MS;
  const working = pending !== null || isStreaming;
  const active = selected || editing || working || isRecent;
  const busy = documentBusy || pending !== null;

  /**
   * The style findings against this section, if any.
   *
   * The voice gate is advisory by design: it never blocks, because a gate
   * that stops a proposal over a word choice teaches people to click
   * through gates. But advisory findings that need the writer to retype the
   * sentence themselves mostly do not get acted on, so the button below
   * hands them straight back to the model as an instruction. One click,
   * using the rewrite path that already exists, and the previous text stays
   * in history if the cure is worse than the disease.
   */
  const voiceNotes = gaps
    .filter((g) => g.detectedBy === "style" && g.status === "open")
    .map((g) => g.message);

  const regenerate = useCallback(async (override?: string) => {
    if (busy) return;
    setPending("regen");
    try {
      const res = await fetch(`/api/proposals/${proposalId}/sections/${section.key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: (override ?? instruction).trim() || undefined }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        body?: string;
        costLabel?: string;
        error?: { message: string; correlationId: string };
      };
      if (!res.ok || !payload.ok || typeof payload.body !== "string") {
        onNotice({
          tone: "bad",
          message: payload.error?.message ?? "That section could not be rewritten.",
          correlationId: payload.error?.correlationId,
        });
        return;
      }
      onBody(payload.body);
      setDraft(payload.body);
      setHistory(null);
      /**
       * The instruction is cleared once it has been used.
       *
       * It is kept across a refresh, because losing an unsent instruction to
       * a reload is the bug this state was added for. It is not kept after a
       * successful rewrite: at that point it has been spent, and leaving it
       * in the box invites a second click that pays for the same instruction
       * twice. The version history keeps a copy either way.
       */
      setInstruction("");
      markTouched();
      if (payload.costLabel) onCost(payload.costLabel);
      onGaps();
      onNotice({
        tone: "good",
        message: `${section.heading} rewritten. Every other section is untouched.`,
      });
    } catch {
      onNotice({ tone: "bad", message: "Could not reach the server. Nothing was changed." });
    } finally {
      setPending(null);
    }
  }, [
    busy,
    instruction,
    markTouched,
    onBody,
    onCost,
    onGaps,
    onNotice,
    proposalId,
    section.heading,
    section.key,
  ]);

  const save = useCallback(async () => {
    if (pending) return;
    setPending("save");
    try {
      const res = await fetch(`/api/proposals/${proposalId}/sections/${section.key}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_md: draft }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: { message: string } };
      if (!res.ok || !payload.ok) {
        onNotice({ tone: "bad", message: payload.error?.message ?? "That edit was not saved." });
        return;
      }
      onBody(draft);
      setEditing(false);
      setRecovered(false);
      setHistory(null);
      clearDraft(storageKey);
      markTouched();
      onGaps();
      onNotice({
        tone: "good",
        message:
          "Saved. The figure checks ran on your text too: a pasted number is checked the same way a generated one is.",
      });
    } catch {
      onNotice({
        tone: "bad",
        message: "Could not reach the server. Your text is still here, and still recoverable.",
      });
    } finally {
      setPending(null);
    }
  }, [draft, markTouched, onBody, onGaps, onNotice, pending, proposalId, section.key, storageKey]);

  const loadHistory = useCallback(async () => {
    setShowHistory((v) => !v);
    if (history) return;
    try {
      const res = await fetch(`/api/proposals/${proposalId}/sections/${section.key}`, {
        cache: "no-store",
      });
      const payload = (await res.json()) as { history?: HistoryEntry[] };
      setHistory(payload.history ?? []);
    } catch {
      setHistory([]);
    }
  }, [history, proposalId, section.key]);

  const revert = useCallback(
    async (version: number) => {
      if (busy) return;
      setPending("revert");
      try {
        const res = await fetch(`/api/proposals/${proposalId}/sections/${section.key}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version }),
        });
        const payload = (await res.json()) as {
          ok?: boolean;
          body?: string;
          error?: { message: string };
        };
        if (!res.ok || !payload.ok || typeof payload.body !== "string") {
          onNotice({
            tone: "bad",
            message: payload.error?.message ?? "Could not restore that version.",
          });
          return;
        }
        onBody(payload.body);
        setDraft(payload.body);
        setHistory(null);
        markTouched();
        onGaps();
        onNotice({ tone: "good", message: `Restored version ${version}.` });
      } catch {
        onNotice({ tone: "bad", message: "Could not reach the server. Nothing was changed." });
      } finally {
        setPending(null);
      }
    },
    [busy, markTouched, onBody, onGaps, onNotice, proposalId, section.key],
  );

  const isEmpty = section.bodyMd.trim().length === 0 && !isStreaming;
  const dirty = editing && draft !== section.bodyMd;

  return (
    <section
      ref={registerRef}
      onClick={onSelect}
      aria-label={section.heading}
      className={`section-shell mb-6 scroll-mt-24 ${active ? "is-active" : ""} ${
        working ? "is-working" : ""
      }`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="font-sans t-sm font-bold uppercase tracking-[0.07em] text-[var(--accent)]">
          {section.heading}
        </h2>
        {gaps.length > 0 ? (
          <Badge tone="attention" glyph="▲">
            {gaps.length}
          </Badge>
        ) : null}
        {section.editedByHuman ? (
          <Badge tone="neutral" glyph="✎">
            edited
          </Badge>
        ) : null}
        {dirty ? (
          <Badge tone="attention" glyph="●">
            unsaved
          </Badge>
        ) : null}
        <span className="ml-auto t-2xs text-[var(--paper-muted)]">v{section.version}</span>
      </div>

      {editing ? (
        <div className="section-editor" onClick={(e) => e.stopPropagation()}>
          {recovered ? (
            <p className="m-0 mb-2 rounded-[var(--radius-sm)] border border-[var(--attention-line)] bg-[var(--attention-soft)] px-2.5 py-1.5 t-xs text-[var(--attention)]">
              Recovered from an unsaved draft in this browser. Save it or discard it.
            </p>
          ) : null}
          <textarea
            className="textarea min-h-[220px] w-full font-serif t-base leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Edit ${section.heading}`}
            disabled={pending === "save"}
            autoFocus
          />
          <p className="hint m-0 mt-1.5">
            Markdown: blank line between paragraphs, <code>- </code> for bullets,{" "}
            <code>**bold**</code>. Use <code>[NEEDS INPUT: your question]</code> to mark something
            deliberately unresolved. It will block approval until answered.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={save}
              disabled={pending !== null}
            >
              {pending === "save" ? "Saving…" : "Save section"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending === "save"}
              onClick={() => {
                setDraft(section.bodyMd);
                setEditing(false);
                setRecovered(false);
                clearDraft(storageKey);
              }}
            >
              Discard
            </button>
            <span className="ml-auto t-2xs text-[var(--muted)]">
              {dirty ? "Kept in this browser until you save" : "No changes yet"}
            </span>
          </div>
        </div>
      ) : (
        <div className="prose-doc">
          {isStreaming ? (
            <StreamingBody text={streamingText} sources={sources} />
          ) : isEmpty ? (
            isGenerating ? (
              <SectionSkeleton />
            ) : (
              <p className="m-0 font-sans t-base text-[var(--paper-muted)]">Not written yet.</p>
            )
          ) : (
            <DocumentBody bodyMd={section.bodyMd} showGaps sources={sources} />
          )}
        </div>
      )}

      {editable && !editing ? (
        <div className="section-tools" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            <span aria-hidden="true">✎</span> Edit
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void regenerate()}
            disabled={busy}
            title="Rewrites this section only. The previous text is kept and can be restored."
          >
            {pending === "regen" ? "Rewriting…" : "Rewrite"}
          </button>
          {voiceNotes.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void regenerate(
                  `Rewrite this section fixing these specific problems, and change nothing else. Keep every figure, date and commitment exactly as it is.\n\n${voiceNotes
                    .map((n) => `- ${n}`)
                    .join("\n")}`,
                )
              }
              title={voiceNotes.join("\n")}
            >
              <span aria-hidden="true">▲</span> Fix the voice ({voiceNotes.length})
            </button>
          ) : null}
          {/*
            A full-strength white input sitting inside a document is a hole in
            the page, and this one is 500px wide and present on all seven
            sections. `.section-instruction` is a hairline at rest and becomes
            a real field on focus: the same target and the same behaviour,
            without the document looking like a form when nobody is typing.
          */}
          <input
            type="text"
            className="section-instruction min-w-0 flex-1"
            placeholder="Tell Claude what to change, then Rewrite"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) {
                e.preventDefault();
                void regenerate();
              }
            }}
            aria-label={`Rewrite instruction for ${section.heading}`}
          />
          {/*
            "v2 history" put the version number in two places two inches
            apart, in the heading and again on the button, and neither of them
            was what the button does. The count of earlier versions is the
            useful figure, because it says whether there is anything to go
            back to.
          */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={loadHistory}
            aria-expanded={showHistory}
            title="Every earlier version of this section, with what produced it"
          >
            History
            {section.version > 1 ? (
              <span className="t-2xs text-[var(--muted)]">{section.version - 1}</span>
            ) : null}
          </button>
        </div>
      ) : null}

      {!editable && lockedReason ? (
        <p className="mt-2 t-xs italic text-[var(--paper-muted)]">{lockedReason}</p>
      ) : null}

      {showHistory ? (
        <div className="section-editor" onClick={(e) => e.stopPropagation()}>
          {history === null ? (
            <div className="skeleton h-[54px]" />
          ) : history.length === 0 ? (
            <p className="hint m-0">No earlier versions.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {history.map((entry) => (
                <li
                  key={entry.version}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-2 t-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold">v{entry.version}</span>
                    <span className="text-[var(--muted)]">
                      {ORIGIN_LABEL[entry.origin] ?? entry.origin}
                    </span>
                    {editable && entry.version < section.version ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm ml-auto"
                        onClick={() => revert(entry.version)}
                        disabled={busy}
                      >
                        Restore
                      </button>
                    ) : null}
                  </div>
                  {entry.instruction ? (
                    <p className="m-0 mt-1 italic text-[var(--ink-2)]">“{entry.instruction}”</p>
                  ) : null}
                  <p className="m-0 mt-1 line-clamp-2 text-[var(--muted)]">
                    {entry.body.slice(0, 120)}
                    {entry.body.length > 120 ? "…" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
