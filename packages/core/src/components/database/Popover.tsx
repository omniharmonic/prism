import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Anchored floating panel (portaled to <body> so table/board overflow never clips
 * it). Closes on outside pointer-down and Escape, returns focus to the anchor.
 * Clamped to the viewport, so it stays usable at 390px.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  label,
  width = 280,
  className = "",
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: number;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const flip = below < 220 && above > below;
      const maxHeight = Math.max(160, Math.min(420, flip ? above : below));
      setPos({ top: flip ? Math.max(8, r.top - 6 - Math.min(maxHeight, panel.current?.offsetHeight ?? maxHeight)) : r.bottom + 6, left, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      // A popover opened FROM this one (e.g. an option picker inside a bulk-edit
      // panel) is portaled beside it; using it must not close its parent.
      if (t instanceof Element && t.closest(".db-popover")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, onClose, anchor]);

  // Keyboard (NP-AX-02): once placed, focus moves into the panel unless something inside already took it
  // (an autofocus field). When the panel closes with focus still inside (or dropped to <body>), it goes
  // back to the anchor — a pointer that moved focus elsewhere keeps it.
  const placed = !!pos;
  useEffect(() => {
    if (!open || !placed) return;
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      (first ?? el).focus({ preventScroll: true });
    }
    return () => {
      const a = document.activeElement;
      if (!a || a === document.body || el?.contains(a)) anchor.current?.focus({ preventScroll: true });
    };
  }, [open, placed, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={`db-popover ${className}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(width, typeof window !== "undefined" ? window.innerWidth - 16 : width), maxHeight: pos?.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  );
}
