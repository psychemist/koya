/**
 * Status values and their presentation, with no dependencies at all.
 *
 * Split out of state.ts on purpose. The state machine throws `AppError` and so
 * reaches the rest of the server library; the badges in the interface need
 * only the label and the tone. Keeping them in one module meant a client
 * component rendering a status pill dragged the whole server graph into the
 * browser bundle, which fails the build the moment anything in that graph
 * touches a `node:` import.
 *
 * The rule this encodes: anything a client component imports must be able to
 * stand on its own.
 */

export const STATUSES = [
  "draft",
  "generating",
  "review",
  "pending_approval",
  "changes_requested",
  "approved",
  "sent",
  "delivery_failed",
] as const;

export type Status = (typeof STATUSES)[number];

export type Tone = "neutral" | "progress" | "attention" | "good" | "bad";

export const STATUS_META: Record<Status, { label: string; tone: Tone; help: string }> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    help: "Intake saved. Nothing has been written yet.",
  },
  generating: {
    label: "Writing",
    tone: "progress",
    help: "Claude is drafting the sections.",
  },
  review: {
    label: "In review",
    tone: "progress",
    help: "Drafted. The salesperson is revising it.",
  },
  pending_approval: {
    label: "Awaiting approval",
    tone: "attention",
    help: "Locked for editing until an approver decides.",
  },
  changes_requested: {
    label: "Changes requested",
    tone: "attention",
    help: "An approver sent it back with a note.",
  },
  approved: {
    label: "Approved",
    tone: "good",
    help: "Cleared to send to the client.",
  },
  sent: {
    label: "Sent",
    tone: "good",
    help: "Delivered to the client. This is a record and cannot be changed.",
  },
  delivery_failed: {
    label: "Delivery failed",
    tone: "bad",
    help: "Approved, but nothing reached the client. Safe to retry.",
  },
};

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function humanStatus(status: string): string {
  const map: Record<string, string> = {
    draft: "a draft",
    generating: "being written",
    review: "in review",
    pending_approval: "awaiting approval",
    changes_requested: "sent back for changes",
    approved: "approved",
    sent: "already sent",
    delivery_failed: "failed to deliver",
  };
  return map[status] ?? status;
}
