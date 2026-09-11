import type { ReactNode } from "react";
import { STATUS_META, type Status } from "../lib/proposal/status";

/**
 * Shared presentational primitives.
 *
 * The rule these all follow: status is never carried by colour alone. Every
 * badge pairs a hue with a glyph and a word, so the interface still works in
 * greyscale, in a printout, and for a reviewer with colour vision deficiency.
 */

const TONE_CLASS = {
  neutral: "badge",
  progress: "badge badge-progress",
  attention: "badge badge-attention",
  good: "badge badge-good",
  bad: "badge badge-bad",
} as const;

/** A small glyph per tone. Text-based, so it needs no icon font. */
const TONE_GLYPH = {
  neutral: "○",
  progress: "◐",
  attention: "▲",
  good: "●",
  bad: "■",
} as const;

export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <span className={TONE_CLASS[meta.tone]}>
      <span aria-hidden="true" style={{ fontSize: "9px", lineHeight: 1 }}>
        {TONE_GLYPH[meta.tone]}
      </span>
      {meta.label}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  glyph,
  children,
}: {
  tone?: keyof typeof TONE_CLASS;
  glyph?: string;
  children: ReactNode;
}) {
  return (
    <span className={TONE_CLASS[tone]}>
      {glyph ? (
        <span aria-hidden="true" style={{ fontSize: "9px", lineHeight: 1 }}>
          {glyph}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/**
 * The disclosure marker, used by every collapsible group in the application.
 *
 * There were four of them and they had four different affordances: a "+", a
 * "−", a word, and in one case nothing at all. A caret that rotates is the
 * convention every reader already has, and it says both "there is more here"
 * and "it is open" with the same mark.
 *
 * Rotation is CSS, driven either by the button's own `aria-expanded` or by
 * `open` on a parent `<details>`, so the mark cannot disagree with the state
 * a screen reader is told about.
 */
export function Caret() {
  return (
    <svg
      className="disclosure-caret"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5L8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

/**
 * A gap count, shown wherever a proposal is listed.
 *
 * Zero open gaps is stated positively rather than shown as an absence: "clear"
 * tells a reviewer the checks ran, whereas a missing badge is ambiguous
 * between "clean" and "not checked yet".
 */
export function GapCount({
  blocking,
  advisory,
  checked = true,
}: {
  blocking: number;
  advisory: number;
  checked?: boolean;
}) {
  if (!checked) {
    return (
      <Badge tone="neutral" glyph="○">
        Not checked
      </Badge>
    );
  }
  if (blocking === 0 && advisory === 0) {
    return (
      <Badge tone="good" glyph="✓">
        No open gaps
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {blocking > 0 ? (
        <Badge tone="attention" glyph="▲">
          {blocking} blocking
        </Badge>
      ) : null}
      {advisory > 0 ? (
        <Badge tone="neutral" glyph="·">
          {advisory} advisory
        </Badge>
      ) : null}
    </span>
  );
}

export function MetricTile({
  label,
  value,
  detail,
  /**
   * True when `value` is a phrase standing in for a figure that does not
   * exist yet. It is set at sentence size rather than display size, because a
   * strip of metrics is scanned as shapes and a missing value is not a large
   * one.
   */
  empty = false,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="metric">
      <div className="eyebrow">{label}</div>
      <div className={`metric-value ${empty ? "is-empty" : ""}`}>{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="t-md">{title}</h3>
      {children ? (
        <p className="hint m-0 max-w-[42ch] t-base leading-relaxed">{children}</p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * The correlation id, rendered so a user can quote it.
 *
 * This is the thread between "the button went red" and the exact `events` row
 * that says why, so it is presented as a first-class, copyable value rather
 * than buried in a console log the user will never open.
 */
export function CorrelationChip({ id }: { id: string }) {
  return (
    <span
      className="mono inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5"
      title="Quote this reference when reporting the problem. It finds the exact log entry."
    >
      <span aria-hidden="true" className="text-[var(--muted)]">
        ref
      </span>
      {id}
    </span>
  );
}

/** An inline error, for form and action failures. */
export function ErrorNote({
  message,
  correlationId,
}: {
  message: string;
  correlationId?: string | null;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-3 py-2 t-base text-[var(--bad)]"
    >
      <span aria-hidden="true">■</span>
      <span className="flex-1">{message}</span>
      {correlationId ? <CorrelationChip id={correlationId} /> : null}
    </div>
  );
}

export function InfoNote({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "attention" }) {
  const cls =
    tone === "good"
      ? "border-[var(--good-line)] bg-[var(--good-soft)] text-[var(--good)]"
      : tone === "attention"
        ? "border-[var(--attention-line)] bg-[var(--attention-soft)] text-[var(--attention)]"
        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-2)]";
  return (
    <div className={`rounded-[var(--radius-sm)] border px-3 py-2 t-base leading-relaxed ${cls}`}>
      {children}
    </div>
  );
}

/** Relative time that degrades to an absolute date beyond a week. */
export function TimeAgo({ at }: { at: Date | string }) {
  const date = typeof at === "string" ? new Date(at) : at;
  const iso = date.toISOString();
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);

  let label: string;
  if (minutes < 1) label = "just now";
  else if (minutes < 60) label = `${minutes}m ago`;
  else if (minutes < 60 * 24) label = `${Math.round(minutes / 60)}h ago`;
  else if (minutes < 60 * 24 * 7) label = `${Math.round(minutes / (60 * 24))}d ago`;
  else
    label = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <time dateTime={iso} title={date.toLocaleString("en-GB")}>
      {label}
    </time>
  );
}
