"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A menu that closes the way people expect one to.
 *
 * This replaces a native `<details>`/`<summary>` pair. Details is the right
 * instinct for a disclosure and the wrong element for a menu: it opens on
 * click and then stays open until the summary is clicked again, so clicking
 * anywhere else on the page leaves it hanging over the content. Every menu a
 * person has used closes on an outside click and on Escape, and one that
 * does not reads as stuck.
 *
 * The trigger toggles rather than only opening, so pressing it a second time
 * closes it, and the outside-click handler is careful to ignore the trigger
 * so the two do not fight and cancel each other out.
 *
 * Closing on scroll is deliberate too: the menu is absolutely positioned
 * against a trigger that scrolls away from it.
 */
export function Dropdown({
  label,
  children,
  disabled = false,
  title,
  align = "right",
  className = "",
  menuClassName = "",
}: {
  label: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  disabled?: boolean;
  title?: string;
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      // The trigger has its own toggle. Treating a press on it as "outside"
      // would close the menu here and immediately reopen it in the click
      // handler, so the button would appear not to work at all.
      if (trigger.current?.contains(target)) return;
      if (panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };

    // Named, so it can actually be removed. An inline arrow here would
    // leave one listener behind every time the menu was opened and closed
    // without scrolling, because the handle passed to remove would be a
    // different function object each render.
    const onScroll = () => setOpen(false);

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span aria-hidden="true" className="t-2xs opacity-70">
          ▾
        </span>
      </button>

      {open && !disabled ? (
        <div
          ref={panel}
          role="menu"
          className={`menu ${align === "left" ? "menu-left" : ""} ${menuClassName}`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}
