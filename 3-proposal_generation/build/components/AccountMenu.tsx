"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "../lib/auth";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The account menu.
 *
 * WHY THIS EXISTS. The header carried six controls on its right-hand side:
 * a three-segment theme switch, a primary action, the signed-in name, the
 * email under it, a role badge, and a sign-out button. Every one of them had
 * a reason to be there and together they read as clutter, because a header
 * is scanned rather than read and six competing items give it no shape.
 *
 * Only two of those are used often: the primary action and, on a shared
 * machine, knowing who you are signed in as. The rest are settings, and
 * settings belong behind a control that says "settings" rather than in the
 * one strip that appears on every page.
 *
 * The role stays visible on the trigger rather than moving inside. In a
 * system whose central guarantee is that a second person approves, which
 * account you are using changes what the buttons do, and a reviewer holding
 * two accounts has to be able to see that without opening anything.
 */
export function AccountMenu({ user, signOut }: { user: User; signOut: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  /** Close on an outside click or Escape, the two things a menu must do. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        className="account-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${user.name}, signed in as ${user.role}`}
      >
        <span className="avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block t-sm font-semibold text-[var(--ink)]">{user.name}</span>
          <span className="block t-2xs uppercase tracking-wide text-[var(--muted)]">
            {user.role}
          </span>
        </span>
        <span aria-hidden="true" className="t-2xs text-[var(--muted)]">
          ▾
        </span>
      </button>

      {open ? (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="t-base font-semibold text-[var(--ink)]">{user.name}</div>
            <div className="truncate t-xs text-[var(--muted)]">{user.email}</div>
            <p className="m-0 mt-1.5 t-xs leading-relaxed text-[var(--ink-2)]">
              Signed in as <strong className="font-semibold">{user.role}</strong>.{" "}
              {user.role === "salesperson"
                ? "You can write and revise, but not approve."
                : user.role === "approver"
                  ? "You can approve anything you did not write yourself."
                  : "You can approve, and manage who else can."}
            </p>
          </div>

          <div className="menu-row">
            <span className="eyebrow">Theme</span>
            <ThemeToggle />
          </div>

          <div className="menu-foot">
            <button type="button" className="btn btn-ghost btn-sm w-full justify-start" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Two letters at most: "Ada Okonkwo" gives AO, "Priya" gives P. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}
