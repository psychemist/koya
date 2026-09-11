"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SECTIONS, type SectionKey } from "../../lib/proposal/sections";
import type { Intake } from "../../lib/proposal/intake";
import { ACCEPTED_UPLOAD_TYPES, MAX_SOURCES_PER_PROPOSAL } from "../../lib/limits";
import { STATUS_META, type Status } from "../../lib/proposal/status";
import type { CitationTarget } from "../DocumentBody";
import { CorrelationChip, InfoNote, StatusBadge } from "../ui";
import { Dropdown } from "../Dropdown";
import { GapPanel, type GapView } from "./GapPanel";
import { IntakeEditor } from "./IntakeEditor";
import { ApproverPicker, type AssignableApprover } from "./ApproverPicker";
import { CommentThread, type CommentView } from "../CommentThread";
import { SectionCard } from "./SectionCard";

/**
 * The workspace: outline, document, inspector.
 *
 * The layout is the argument. A proposal is a document, so it gets a paper
 * surface and a real measure in the middle of the screen; the tooling sits
 * either side and stays out of the way. The alternative — a chat transcript
 * with the proposal somewhere inside it — makes the artefact feel like a
 * by-product of talking to a model, which is exactly the wrong impression to
 * give a salesperson about to put their name on it.
 *
 * Streaming state is held per section so the outline can show which one is
 * being written while the reader watches it arrive.
 */

export type SectionView = {
  key: SectionKey;
  heading: string;
  bodyMd: string;
  version: number;
  editedByHuman: boolean;
  updatedAt: string;
};

export type WorkspaceProps = {
  proposalId: string;
  ref_: string;
  status: Status;
  version: number;
  isAuthor: boolean;
  /**
   * Whether this viewer may edit the document, decided on the server by
   * `canAccess(..., "edit")`. Not the same question as whether the document's
   * status allows editing at all.
   */
  canEdit: boolean;
  canApprove: boolean;
  /** Null for anyone who should not see the spend. */
  costLabel: string | null;
  /** Approvers and admins who could sign this off. Empty for a small firm. */
  approvers: AssignableApprover[];
  assignedApproverId: string | null;
  /** Set once somebody has approved, which settles the question. */
  approvedByName: string | null;
  companyName: string;
  clientName: string;
  /** The call notes, editable in the rail. */
  intake: Intake;
  sections: SectionView[];
  gaps: GapView[];
  sources: {
    id: string;
    filename: string;
    status: string;
    summary: string;
    pageCount: number | null;
    /**
     * The number this attachment carries in `[[source:N]]` markers, or null
     * if it never reached the model. Computed on the server, because only
     * the server knows which uploads were usable.
     */
    citationIndex: number | null;
  }[];
  approvals: { decision: string; note: string | null; actorName: string; createdAt: string }[];
  comments: CommentView[];
};

type Notice = {
  tone: "good" | "bad" | "neutral";
  message: string;
  correlationId?: string | null;
};

export function Workspace(props: WorkspaceProps) {
  const [status, setStatus] = useState<Status>(props.status);
  const [sections, setSections] = useState<SectionView[]>(props.sections);
  const [gaps, setGaps] = useState<GapView[]>(props.gaps);
  const [selected, setSelected] = useState<SectionKey>(props.sections[0]?.key ?? "introduction");

  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [costLabel, setCostLabel] = useState(props.costLabel);

  const abortRef = useRef<AbortController | null>(null);
  const sectionRefs = useRef<Partial<Record<SectionKey, HTMLElement | null>>>({});

  /**
   * Two different questions, and conflating them was a bug.
   *
   *   documentIsOpen  the STATUS permits editing: nobody has submitted it and
   *                   nothing is frozen.
   *   editable        ...and THIS VIEWER is allowed to do it.
   *
   * `editable` used to be the first of these alone, so an approver opening a
   * colleague's draft got the full authoring toolbar: Draft with Claude,
   * Submit for approval, every section editor, the call-notes editor and the
   * attachment control. The server refused each one on the way in, so nothing
   * could actually be done, but hiding a control is a courtesy to the person
   * who should not press it and this interface was not even doing that.
   *
   * The distinction is kept rather than collapsed because the explanatory
   * copy needs both: "this is finished" and "this is not yours" are different
   * sentences, and telling an approver a live draft is uneditable would be a
   * new inaccuracy in place of the old one.
   */
  const documentIsOpen =
    status === "draft" || status === "review" || status === "changes_requested";
  const editable = documentIsOpen && props.canEdit;
  const isGenerating = busy === "generate";

  const openBlocking = gaps.filter((g) => g.status === "open" && g.severity === "blocking");

  const openAdvisory = gaps.filter((g) => g.status === "open" && g.severity === "advisory");
  const written = sections.filter((s) => s.bodyMd.trim().length > 0).length;
  const hasDraft = written >= SECTIONS.length;

  /**
   * Delivery is the end of a sequence, and the button says where you are in
   * it. Each reason names the next thing to do rather than restating the
   * status, because "pending approval" does not tell an author whether they
   * are waiting or whether they are the blocker.
   */
  /**
   * Who may pull it back. Mirrors `assertCanWithdraw`, which enforces it.
   * Getting this wrong here only shows or hides a button; the server is
   * where it counts.
   */
  const canRecall =
    (status === "pending_approval" && props.isAuthor) ||
    (status === "approved" && (props.isAuthor || props.canApprove));

  const deliverReady = status === "approved" || status === "delivery_failed";
  const deliverBlockedWhy =
    status === "sent"
      ? "Already sent. A sent proposal is a record of what the client received, so it cannot be sent again."
      : status === "pending_approval"
        ? "Waiting on an approver. Nothing can be delivered until somebody who did not write it has approved it."
        : openBlocking.length > 0
          ? `${openBlocking.length} blocking gap${openBlocking.length === 1 ? "" : "s"} to clear, then submit for approval. Delivery comes after that.`
          : !hasDraft
            ? "Write the proposal first, then submit it for approval. Delivery is the step after approval."
            : "Submit for approval first. A second person has to approve it before it can reach a client.";

  const citations = useMemo<CitationTarget[]>(
    () =>
      props.sources.flatMap((s) =>
        s.citationIndex === null ? [] : [{ index: s.citationIndex, filename: s.filename }],
      ),
    [props.sources],
  );

  const gapsBySection = useMemo(() => {
    const map = new Map<string, GapView[]>();
    for (const gap of gaps) {
      if (gap.status !== "open") continue;
      const key = gap.sectionKey ?? "__general";
      map.set(key, [...(map.get(key) ?? []), gap]);
    }
    return map;
  }, [gaps]);

  const patchSection = useCallback((key: SectionKey, bodyMd: string, bumpVersion = true) => {
    setSections((prev) =>
      prev.map((s) =>
        s.key === key
          ? {
              ...s,
              bodyMd,
              version: bumpVersion ? s.version + 1 : s.version,
              updatedAt: new Date().toISOString(),
            }
          : s,
      ),
    );
  }, []);

  /**
   * Scrolls a section into view from the outline.
   *
   * `scrollIntoView({ block: "start" })` was right for one of the two layouts
   * and wrong for the other, which is why this is no longer a one-liner.
   *
   * At 1024px and above the centre column is its own scroll container, so
   * "put this section at the top" moves that column and nothing else. Below
   * 1024px `.pane` has no `overflow-y`, the three panes are stacked, and the
   * whole document scrolls instead. Asking the browser to put the LAST
   * section at the top of the viewport then scrolls the page as far as it
   * can go — which drags the inspector, sitting directly beneath the
   * document in the stacked order, up into a third of the screen. It reads
   * as a footer leaping into view, because that is exactly what it is.
   *
   * So: let the browser do it when a real scroll container will absorb the
   * movement, and otherwise scroll the page by hand, clamped so it never
   * travels past the bottom of the document column. The inspector is still
   * reachable by scrolling — it is simply no longer somewhere the outline
   * sends you.
   */
  const scrollTo = useCallback((key: SectionKey) => {
    setSelected(key);
    const el = sectionRefs.current[key];
    if (!el) return;

    const pane = el.closest(".pane") as HTMLElement | null;
    // +1 absorbs sub-pixel heights, which otherwise report a one-pixel
    // overflow on a container that does not actually scroll.
    const paneScrolls = pane !== null && pane.scrollHeight > pane.clientHeight + 1;

    if (paneScrolls) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const doc = document.scrollingElement ?? document.documentElement;
    // The toolbar is sticky, so landing a heading at scroll position zero
    // puts it underneath. This is its height plus a little air.
    const STICKY_OFFSET = 60;
    const wanted = window.scrollY + el.getBoundingClientRect().top - STICKY_OFFSET;

    const documentColumnBottom = pane
      ? window.scrollY + pane.getBoundingClientRect().bottom - window.innerHeight
      : doc.scrollHeight - window.innerHeight;
    const ceiling = Math.max(
      0,
      Math.min(documentColumnBottom, doc.scrollHeight - window.innerHeight),
    );

    window.scrollTo({ top: Math.max(0, Math.min(wanted, ceiling)), behavior: "smooth" });
  }, []);

  /**
   * Runs generation, consuming the SSE stream.
   *
   * The reader is driven manually rather than with EventSource because
   * EventSource cannot issue a POST, and generation must not be a GET — a GET
   * that spends money and mutates state would be retried by any proxy or
   * prefetcher that felt like it.
   */
  const generate = useCallback(
    async (force: boolean) => {
      if (busy) return;
      setBusy("generate");
      setNotice(null);
      setStreaming({});

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(
          `/api/proposals/${props.proposalId}/generate${force ? "?force=1" : ""}`,
          { method: "POST", signal: controller.signal },
        );

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: { message?: string; correlationId?: string } }
            | null;
          setNotice({
            tone: "bad",
            message:
              payload?.error?.message ?? `Generation could not start (HTTP ${response.status}).`,
            correlationId: payload?.error?.correlationId ?? null,
          });
          return;
        }

        setStatus("generating");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line. Anything after the last
          // separator is a partial frame and stays in the buffer.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            } catch {
              continue;
            }
            handleEvent(event);
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          setNotice({
            tone: "neutral",
            message:
              "Stopped watching. Generation carries on server-side, so reload in a moment to see the result.",
          });
        } else {
          setNotice({
            tone: "bad",
            message:
              "The connection dropped while the proposal was being written. Reload to see how far it got.",
          });
        }
      } finally {
        setBusy(null);
        setActiveSection(null);
        abortRef.current = null;
      }

      function handleEvent(event: Record<string, unknown>): void {
        const type = String(event.type);

        if (type === "section_start") {
          const key = event.key as SectionKey;
          setActiveSection(key);
          setSelected(key);
          setStreaming((prev) => ({ ...prev, [key]: "" }));
          return;
        }

        if (type === "delta") {
          const key = String(event.key);
          const text = String(event.text ?? "");
          setStreaming((prev) => ({ ...prev, [key]: (prev[key] ?? "") + text }));
          return;
        }

        if (type === "section_done") {
          const key = event.key as SectionKey;
          patchSection(key, String(event.body ?? ""));
          setStreaming((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          return;
        }

        if (type === "cache_hit") {
          setNotice({ tone: "good", message: String(event.message ?? "") });
          return;
        }

        if (type === "gates") {
          const degraded = (event.degraded as string[] | undefined) ?? [];
          if (degraded.length > 0) {
            setNotice({
              tone: "neutral",
              message: `Drafted, but ${degraded.join(" and ")} was unavailable, so that check did not run. The figure checks did.`,
            });
          }
          // The authoritative gap list comes from the server on reload; this
          // keeps the counts honest in the meantime.
          void refreshGaps();
          return;
        }

        if (type === "done") {
          setStatus("review");
          setCostLabel(String(event.costLabel ?? costLabel));
          setNotice((current) =>
            current ?? {
              tone: "good",
              message: `Draft complete. ${event.sections} sections, ${event.costLabel}.`,
            },
          );
          return;
        }

        if (type === "error") {
          setStatus("draft");
          setNotice({
            tone: "bad",
            message: String(event.message ?? "Generation failed."),
            correlationId: (event.correlationId as string) ?? null,
          });
        }
      }
    },
    [busy, costLabel, patchSection, props.proposalId],
  );

  const refreshGaps = useCallback(async () => {
    try {
      const res = await fetch(`/api/proposals/${props.proposalId}/gaps`, { cache: "no-store" });
      if (!res.ok) return;
      const payload = (await res.json()) as { gaps?: GapView[] };
      if (payload.gaps) setGaps(payload.gaps);
    } catch {
      // A failed refresh is cosmetic; the next page load is authoritative.
    }
  }, [props.proposalId]);

  /**
   * Attaching supporting material after the proposal exists.
   *
   * The upload only used to be on the intake form, so the one moment you
   * could attach a document was before you had read the draft — and reading
   * the draft is exactly when you notice that the scope section needs the
   * statement of work that arrived afterwards.
   *
   * `router.refresh()` rather than local state for the new source rows: the
   * server decides a source's citation index, its extraction status and
   * whether it raised an advisory gap, and none of those can be guessed in
   * the browser. Re-rendering from the server is the only version that is
   * not a guess. The transient notice carries the outcome in the meantime.
   */
  const router = useRouter();
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const attachSources = useCallback(
    async (fileList: FileList | null) => {
      const files = fileList ? [...fileList] : [];
      if (files.length === 0 || busy) return;

      setBusy("attach");
      setNotice(null);
      try {
        const form = new FormData();
        for (const file of files) form.append("sources", file);

        const res = await fetch(`/api/proposals/${props.proposalId}/sources`, {
          method: "POST",
          body: form,
        });
        const payload = (await res.json()) as {
          ok?: boolean;
          ingested?: number;
          flagged?: number;
          rejected?: number;
          correlationId?: string;
          error?: { message?: string };
        };

        if (!res.ok || !payload.ok) {
          setNotice({
            tone: "bad",
            message: payload.error?.message ?? "The attachment could not be added.",
            correlationId: payload.correlationId ?? null,
          });
          return;
        }

        const parts = [
          `${payload.ingested ?? files.length} file${(payload.ingested ?? files.length) === 1 ? "" : "s"} attached.`,
        ];
        if (payload.flagged) {
          // Said plainly rather than left to be discovered in the gap panel:
          // a flagged upload is the one a person actually has to look at.
          parts.push(
            `${payload.flagged} raised an advisory note. Check the gaps panel before approving.`,
          );
        }
        if (payload.rejected) {
          parts.push(
            `${payload.rejected} was not added: the limit is ${MAX_SOURCES_PER_PROPOSAL} per proposal.`,
          );
        }
        // The notice palette has no "attention"; a flagged upload is not an
        // error, so it stays neutral and the sentence carries the weight.
        setNotice({ tone: payload.flagged ? "neutral" : "good", message: parts.join(" ") });

        await refreshGaps();
        router.refresh();
      } catch (err) {
        setNotice({
          tone: "bad",
          message: err instanceof Error ? err.message : "The attachment could not be added.",
        });
      } finally {
        setBusy(null);
        // Clearing the input matters: without it, re-picking the same file
        // fires no change event and the second attempt looks like a dead
        // button.
        if (uploadRef.current) uploadRef.current.value = "";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, props.proposalId, refreshGaps, router],
  );

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy("submit");
    setNotice(null);
    try {
      const res = await fetch(`/api/proposals/${props.proposalId}/submit`, { method: "POST" });
      const payload = (await res.json()) as {
        ok?: boolean;
        status?: Status;
        error?: { message: string; correlationId: string };
      };
      if (!res.ok || !payload.ok) {
        setNotice({
          tone: "bad",
          message: payload.error?.message ?? "Could not submit for approval.",
          correlationId: payload.error?.correlationId,
        });
        return;
      }
      setStatus(payload.status ?? "pending_approval");
      setNotice({
        tone: "good",
        message:
          "Sent for approval. It is locked for editing until an approver decides, and you are not one of them for this proposal.",
      });
    } catch {
      setNotice({ tone: "bad", message: "Could not reach the server. Nothing was changed." });
    } finally {
      setBusy(null);
    }
  }, [busy, props.proposalId, status]);

  /**
   * Take it back, from either state it can be taken back from.
   *
   * `pending_approval` is a withdrawal, author only: an approver wanting
   * changes uses "request changes", which records a decision and a note.
   * `approved` is a recall, and an approver may do that one too, because
   * approving the wrong version is their mistake to undo. Both land in
   * `review`, which also stops the client link resolving.
   */
  const withdraw = useCallback(async () => {
    if (busy) return;
    setBusy("withdraw");
    setNotice(null);
    try {
      const res = await fetch(`/api/proposals/${props.proposalId}/withdraw`, { method: "POST" });
      const payload = (await res.json()) as {
        ok?: boolean;
        status?: Status;
        error?: { message: string; correlationId: string };
      };
      if (!res.ok || !payload.ok) {
        setNotice({
          tone: "bad",
          message: payload.error?.message ?? "Could not withdraw it.",
          correlationId: payload.error?.correlationId,
        });
        return;
      }
      const wasApproved = status === "approved";
      setStatus(payload.status ?? "review");
      setNotice({
        tone: "good",
        message: wasApproved
          ? "Recalled. The client link has stopped working, and it will need approving again before it can be sent."
          : "Back in your hands. Fix what you need to and submit it again.",
      });
    } catch {
      setNotice({ tone: "bad", message: "Could not reach the server. Nothing was changed." });
    } finally {
      setBusy(null);
    }
  }, [busy, props.proposalId]);

  /**
   * The one action the workflow is waiting for, and the only one styled as
   * primary.
   *
   * The toolbar used to give the primary treatment to "Regenerate all",
   * which is the most expensive button on the page and the only one that
   * throws away work: it spends a model call per section and replaces every
   * hand edit in all seven of them. "Submit for approval", the step that
   * actually moves the proposal forward, sat beside it as a plain grey
   * button. So the loudest control on the screen was the one a person should
   * think twice about, and the quiet one was the one they came to press.
   *
   * There is exactly one next step at any point in the lifecycle, and this
   * works out which. Everything else is a tool, and tools look like tools.
   */
  const primaryAction: ReactNode = editable
    ? hasDraft
      ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={Boolean(busy)}
          >
            {busy === "submit" ? "Submitting…" : "Submit for approval"}
          </button>
        )
      : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => generate(false)}
            disabled={Boolean(busy)}
          >
            {isGenerating ? "Writing…" : "Draft with Claude"}
          </button>
        )
    : status === "pending_approval" && props.canApprove
      ? (
          <Link
            href={`/proposals/${props.proposalId}/approve`}
            className="btn btn-good btn-sm no-underline hover:no-underline"
          >
            Review and approve
          </Link>
        )
      : deliverReady && props.isAuthor
        ? (
            <Link
              href={`/proposals/${props.proposalId}/deliver`}
              className="btn btn-good btn-sm no-underline hover:no-underline"
            >
              Deliver to client
            </Link>
          )
        : null;

  /**
   * Above `lg` the three columns own the viewport and each scrolls inside
   * itself. Below it they stack and the page scrolls once. See `.pane`.
   */
  return (
    <div className="grid grid-cols-1 lg:h-full lg:grid-cols-[228px_minmax(0,1fr)_340px]">
      {/* ---------------------------------------------------------- outline */}
      <aside className="pane hidden border-r border-[var(--border)] bg-[var(--surface)] p-3 lg:block">
        <div className="eyebrow mb-2 px-1">Document</div>
        <nav className="flex flex-col gap-0.5" aria-label="Sections">
          {sections.map((section) => {
            const isActive = section.key === selected;
            const isStreaming = activeSection === section.key;
            const sectionGaps = gapsBySection.get(section.key) ?? [];
            const hasBlocking = sectionGaps.some((g) => g.severity === "blocking");
            const isEmpty = section.bodyMd.trim().length === 0;

            return (
              <button
                key={section.key}
                type="button"
                onClick={() => scrollTo(section.key)}
                aria-current={isActive ? "true" : undefined}
                className={`relative flex w-full items-center gap-2 rounded-[var(--radius-sm)] py-[7px] pr-2 pl-3 text-left t-sm transition-colors before:absolute before:inset-y-[5px] before:left-[3px] before:w-[2px] before:rounded-full before:bg-[var(--select-line)] before:transition-opacity ${
                  isActive
                    ? "bg-[var(--select)] font-semibold text-[var(--ink)] before:opacity-100"
                    : "text-[var(--ink-2)] before:opacity-0 hover:bg-[var(--surface-2)]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`t-2xs ${
                    isStreaming
                      ? "animate-pulse-soft text-[var(--accent)]"
                      : hasBlocking
                        ? "text-[var(--attention)]"
                        : isEmpty
                          ? "text-[var(--muted)]"
                          : "text-[var(--good)]"
                  }`}
                >
                  {isStreaming ? "◐" : hasBlocking ? "▲" : isEmpty ? "○" : "●"}
                </span>
                <span className="flex-1 truncate">{section.heading}</span>
                {section.editedByHuman ? (
                  <span
                    className="t-2xs text-[var(--accent)]"
                    title="Edited by hand"
                    aria-label="Edited by hand"
                  >
                    ✎
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        {/*
          Who is being asked to approve this.

          Placed in the outline rail rather than the inspector because it is a
          property of the document rather than of the review: it is decided
          while writing, and it is the question a salesperson answers just
          before submitting.
        */}
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <ApproverPicker
            proposalId={props.proposalId}
            approvers={props.approvers}
            assignedId={props.assignedApproverId}
            editable={editable && props.isAuthor}
            approvedByName={props.approvedByName}
          />
        </div>

        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
            <span className="eyebrow">Attachments</span>
            {props.sources.length > 0 ? (
              <span className="t-2xs text-[var(--muted)]">
                {props.sources.length}/{MAX_SOURCES_PER_PROPOSAL}
              </span>
            ) : null}
          </div>
          {props.sources.length === 0 ? (
            <p className="hint px-1">None attached.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {props.sources.map((source) => (
                <li key={source.id} className="px-1 t-xs leading-snug">
                  <div className="flex items-start gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`mt-[3px] t-2xs ${
                        source.status === "ok" ? "text-[var(--good)]" : "text-[var(--attention)]"
                      }`}
                    >
                      {source.status === "ok" ? "●" : "▲"}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        {/*
                          The citation number, so a "◇ meridian-INV-4471" chip
                          in the document has something to point back at.
                          Absent when the upload never reached the model, which
                          is the case worth noticing: a file listed here with
                          no number contributed nothing to the text.
                        */}
                        {source.citationIndex !== null ? (
                          <span className="mono shrink-0 t-2xs text-[var(--accent)]">
                            [{source.citationIndex}]
                          </span>
                        ) : null}
                        <span className="truncate font-medium text-[var(--ink-2)]">
                          {source.filename}
                        </span>
                      </div>
                      <div className="text-[var(--muted)]">{source.summary}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/*
            Adding material after the fact.

            A label wrapping a visually hidden input, rather than a button
            that calls `.click()` on one: the label IS the control, so it is
            reachable by keyboard and announced correctly without any of that
            being re-implemented. The same pattern the intake form's dropzone
            uses.

            Shown only while the document is editable, because the route
            refuses otherwise and offering a control that always fails is
            worse than not offering it. The explanation replaces it rather
            than leaving a gap, so the absence is legible.
          */}
          {editable ? (
            <div className="mt-2.5 px-1">
              <label
                className={`btn btn-sm w-full justify-center ${
                  busy === "attach" ? "pointer-events-none opacity-60" : "cursor-pointer"
                }`}
                htmlFor="attach-sources"
              >
                <span aria-hidden="true">+</span>
                {busy === "attach" ? "Reading…" : "Click to add"}
              </label>
              <input
                ref={uploadRef}
                id="attach-sources"
                type="file"
                name="sources"
                multiple
                accept={ACCEPTED_UPLOAD_TYPES}
                className="sr-only"
                disabled={Boolean(busy)}
                onChange={(e) => void attachSources(e.currentTarget.files)}
              />
              <p className="hint mt-1.5">
                PDF, Word, text or CSV. A scan with no text layer is read by Claude and
                flagged for checking.
              </p>
            </div>
          ) : (
            <p className="hint mt-2.5 px-1">
              {documentIsOpen
                ? "Only the salesperson who wrote this can attach material to it."
                : status === "pending_approval"
                  ? "With an approver, so material cannot be added. Withdraw it to attach more."
                  : "This proposal is no longer editable, so its attachments are fixed."}
            </p>
          )}
        </div>
      </aside>

      {/* --------------------------------------------------------- document */}
      <div className="pane bg-[var(--page)]">
        <div className="toolbar">
          <div className="toolbar-group min-w-0">
            <StatusBadge status={status} />
            <span className="hint m-0 hidden truncate md:inline">{STATUS_META[status].help}</span>
          </div>

          <div className="toolbar-group ml-auto">
            {costLabel ? (
              <span
                className="toolbar-cost hidden sm:inline"
                title="Measured Claude spend on this proposal"
              >
                {costLabel}
              </span>
            ) : null}

            {/* ---- tools: things you may do, in whatever order ---- */}

            {/*
              Regenerating is a tool, not the next step, so once a draft
              exists it is a plain button. Before one exists it IS the next
              step, and it moves into the primary slot below rather than
              appearing twice.
            */}
            {editable && hasDraft ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => generate(true)}
                disabled={Boolean(busy)}
                title="Rewrites all seven sections from the call notes. Each section keeps its history, so a hand edit can be restored."
              >
                {isGenerating ? "Writing…" : "Regenerate all"}
              </button>
            ) : null}

            {isGenerating ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => abortRef.current?.abort()}
              >
                Stop watching
              </button>
            ) : null}

            {/*
              Submit, before there is anything to submit.

              It stays on screen and disabled for the same reason Deliver does:
              a control that only appears once the step before it is finished
              teaches nothing about the sequence, and somebody looking for "how
              does this get approved?" finds nothing on the page. Once a draft
              exists this moves into the primary slot, because by then it is
              the next thing to do rather than a signpost.
            */}
            {editable && !hasDraft ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled
                title={`Every section needs text before an approver sees it. ${written} of ${SECTIONS.length} have been written.`}
              >
                Submit for approval
              </button>
            ) : null}

            {canRecall ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={withdraw}
                disabled={Boolean(busy)}
                title={
                  status === "approved"
                    ? "Takes it back for editing. The client link stops working and it will need approving again."
                    : "Takes it out of the approval queue and unlocks it so you can edit again."
                }
              >
                {busy === "withdraw"
                  ? "Taking it back…"
                  : status === "approved"
                    ? "Recall"
                    : "Withdraw"}
              </button>
            ) : null}

            {/*
              Deliver stays on screen for the author even when it cannot be
              used, and disabled with the reason attached.

              Hiding it meant the last step of the workflow only existed once
              the step before it was finished, so somebody looking for "how do
              I send this?" found nothing on the page and no sign that sending
              was something it could do. A disabled control with a reason
              teaches the sequence; an absent one teaches nothing. When it can
              be used it is the next step, and it moves to the primary slot.
            */}
            {props.isAuthor && !deliverReady ? (
              <button type="button" className="btn btn-sm" disabled title={deliverBlockedWhy}>
                Deliver to client
              </button>
            ) : null}

            {/*
              Download is disabled until every section has text. Offering it
              on an empty proposal produces a PDF with the client's name at
              the top and nothing underneath, which is worse than no file at
              all: it looks like a finished document and it is the sort of
              thing that gets forwarded by accident. The title says why, so
              the greyed-out control is not a dead end.
            */}
            <Dropdown
              label="Download"
              disabled={!hasDraft}
              title={
                hasDraft
                  ? undefined
                  : `Nothing to download yet. ${written} of ${SECTIONS.length} sections have been written.`
              }
              menuClassName="w-[196px] p-1"
            >
              {(close) =>
                (
                  [
                    ["pdf", "PDF"],
                    ["docx", "Word (.docx)"],
                    ["md", "Markdown"],
                  ] as const
                ).map(([fmt, label]) => (
                  <a
                    key={fmt}
                    href={`/api/proposals/${props.proposalId}/document?format=${fmt}`}
                    className="btn btn-ghost btn-sm w-full justify-start no-underline hover:no-underline"
                    onClick={close}
                  >
                    {label}
                  </a>
                ))
              }
            </Dropdown>

            {/* ---- and the one step the workflow is actually waiting for ---- */}
            {primaryAction ? (
              <>
                <span className="toolbar-rule" aria-hidden="true" />
                {primaryAction}
              </>
            ) : null}
          </div>
        </div>

        {/*
          The outline, for a screen too narrow to show the rail.

          Below 1024px the left column is hidden, which left a phone with no
          way to reach the pricing section of a seven-section document except
          by scrolling past the whole thing. The same list, laid out as a
          scrolling strip, costs one row of height.
        */}
        <nav
          className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 lg:hidden"
          aria-label="Sections"
        >
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              onClick={() => scrollTo(section.key)}
              aria-current={section.key === selected ? "true" : undefined}
              className={`filter-chip ${section.key === selected ? "is-active" : ""}`}
            >
              {section.heading}
            </button>
          ))}
        </nav>

        {notice ? (
          <div className="px-5 pt-4">
            <div
              role="status"
              className={`animate-fade-up flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2 t-base ${
                notice.tone === "bad"
                  ? "border-[var(--bad-line)] bg-[var(--bad-soft)] text-[var(--bad)]"
                  : notice.tone === "good"
                    ? "border-[var(--good-line)] bg-[var(--good-soft)] text-[var(--good)]"
                    : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-2)]"
              }`}
            >
              <span aria-hidden="true">
                {notice.tone === "bad" ? "■" : notice.tone === "good" ? "●" : "○"}
              </span>
              <span className="flex-1">{notice.message}</span>
              {notice.correlationId ? <CorrelationChip id={notice.correlationId} /> : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        ) : null}

        <article className="mx-auto max-w-[46rem] px-5 py-7">
          <div className="paper px-8 py-9 sm:px-12 sm:py-12">
            <header className="mb-9 border-b border-[var(--paper-rule)] pb-7">
              <div className="eyebrow text-[var(--accent)]">Koya Talent</div>
              <h1 className="mt-3 font-serif text-[34px] font-normal leading-[1.1] tracking-[-0.025em] text-[var(--paper-ink)]">
                Proposal
              </h1>
              <p className="mt-1.5 font-serif t-lg italic text-[var(--paper-muted)]">
                for {props.companyName}
              </p>
              <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 t-sm">
                <dt className="eyebrow">Prepared for</dt>
                <dd className="m-0 text-[var(--paper-ink)]">{props.clientName}</dd>
                <dt className="eyebrow">Reference</dt>
                <dd className="mono m-0 text-[var(--paper-ink)]">{props.ref_}</dd>
              </dl>
            </header>

            {sections.map((section) => (
              <SectionCard
                key={section.key}
                proposalId={props.proposalId}
                section={section}
                sources={citations}
                gaps={gapsBySection.get(section.key) ?? []}
                editable={editable}
                selected={selected === section.key}
                onSelect={() => setSelected(section.key)}
                streamingText={streaming[section.key]}
                isGenerating={isGenerating}
                documentBusy={Boolean(busy)}
                onBody={(body) => patchSection(section.key, body)}
                onNotice={setNotice}
                onGaps={refreshGaps}
                onCost={setCostLabel}
                registerRef={(el) => {
                  sectionRefs.current[section.key] = el;
                }}
                lockedReason={
                  // "not yours" first: for an approver reading a live draft it
                  // is the true reason, and the status ones would all be wrong.
                  documentIsOpen
                    ? "Only the salesperson who wrote this can edit it. Leave a comment if something needs changing."
                    : status === "pending_approval" && props.isAuthor
                      ? "Locked while it is with an approver. Withdraw it above to edit."
                      : status === "pending_approval"
                        ? "Locked while it is with an approver."
                        : `Locked: this proposal is ${STATUS_META[status].label.toLowerCase()}.`
                }
              />
            ))}
          </div>

          <p className="hint mt-4 text-center">
            Gap markers shown in amber are internal. They are stripped from every client-facing
            output, and a blocking one prevents approval outright.
          </p>
        </article>
      </div>

      {/* -------------------------------------------------------- inspector */}
      <aside className="pane border-t border-[var(--border)] bg-[var(--surface)] p-4 lg:border-l lg:border-t-0">
        {status === "pending_approval" ? (
          <div className="rail-section">
            <InfoNote tone="attention">
              {props.isAuthor
                ? openBlocking.length > 0
                  ? `Waiting for approval, so editing and gap actions are switched off. ${
                      openBlocking.length === 1
                        ? "One blocking gap is still open, which means it cannot be approved as it stands"
                        : `${openBlocking.length} blocking gaps are still open, which means it cannot be approved as it stands`
                    }. Withdraw it to deal with them.`
                  : "Waiting for approval, so editing is switched off until an approver decides. Withdraw it if you need to change something first."
                : "Locked while it is awaiting approval. An approver must either approve it or send it back before it can be edited."}
            </InfoNote>
          </div>
        ) : null}

        {props.approvals.length > 0 ? (
          <div className="rail-section">
            <div className="rail-title mb-2">Approval history</div>
            <ul className="flex flex-col gap-2">
              {props.approvals.map((a, i) => (
                <li
                  key={i}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 t-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="t-2xs">
                      {a.decision === "approved" ? "●" : "▲"}
                    </span>
                    <span className="font-semibold">
                      {a.decision === "approved" ? "Approved" : "Changes requested"}
                    </span>
                    <span className="ml-auto text-[var(--muted)]">{a.actorName}</span>
                  </div>
                  {a.note ? <p className="m-0 mt-1 text-[var(--ink-2)]">{a.note}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
          Above the gaps, deliberately.
          
          Most blocking gaps say a field is empty, and the fix for those is
          here rather than in the panel below. Putting the correction after
          the complaint would leave the panel's two buttons, resolve and
          waive, as the only visible responses to "client email is missing",
          and neither of them fills anything in.
        */}
        <IntakeEditor
          proposalId={props.proposalId}
          intake={props.intake}
          editable={editable}
          onNotice={setNotice}
          onGaps={refreshGaps}
          lockedReason={
            documentIsOpen
              ? "Only the salesperson who wrote this can change the call notes."
              : status === "pending_approval" && props.isAuthor
              ? "Locked while it is with an approver. Withdraw it above to change these."
              : status === "pending_approval"
                ? "Locked while it is with an approver."
                : `Locked: this proposal is ${STATUS_META[status].label.toLowerCase()}.`
          }
        />

        <GapPanel
          proposalId={props.proposalId}
          gaps={gaps}
          onChange={setGaps}
          canAct={editable || props.canApprove}
          /*
           * A gap names the section it was found in, and until now that name
           * was plain grey text. Every one of these findings is acted on by
           * reading the paragraph it is about, which was a scroll and a hunt
           * away in a seven-section document. It is a link to the thing it
           * describes, so it behaves like one.
           */
          onJump={(key) =>
            SECTIONS.some((s) => s.key === key) ? scrollTo(key as SectionKey) : undefined
          }
          lockedReason={
            status === "pending_approval"
              ? props.isAuthor
                ? "Locked while it is with an approver. Withdraw it to act on this."
                : "Locked while it is with an approver."
              : STATUS_META[status]
                ? `Locked: this proposal is ${STATUS_META[status].label.toLowerCase()}.`
                : null
          }
        />

        {/*
          Where the author reads what a reviewer asked. Sits below the gaps
          because gaps are the thing that blocks and comments are the thing
          that explains; showing the conversation first would invert which of
          the two has to be dealt with before approval.
        */}
        <CommentThread proposalId={props.proposalId} initial={props.comments} />

        <div className="rail-section">
          <div className="rail-title mb-2">Checks</div>
          <ul className="flex flex-col gap-1 t-sm text-[var(--ink-2)]">
            <li>
              {openBlocking.length === 0 ? "✓" : "▲"} {openBlocking.length} blocking gap
              {openBlocking.length === 1 ? "" : "s"} open
            </li>
            <li>
              · {openAdvisory.length} advisory
            </li>
            <li>
              {hasDraft ? "✓" : "○"} {written} of {SECTIONS.length} sections written
            </li>
          </ul>
          <p className="hint mt-2">
            Figures, dates, durations and percentages are checked against the intake and the
            attachments on every draft and every edit. Anything not found there is flagged.
          </p>
        </div>
      </aside>
    </div>
  );
}
