/**
 * Swipe actions for list rows on touch devices (wave 3): drag a row sideways to
 * reveal an action, release past the threshold to run it — inbox rows
 * (archive / mark read), page-tree rows (favorite / more).
 *
 * Additive only: every action is also a visible, keyboard-reachable button or
 * menu item on the row. Touch events only, so a mouse or trackpad never triggers it.
 *
 * Never starts:
 *  - inside a sideways scroller (a board, table, code block owns its own drag);
 *  - within 24 px of the left screen edge (the shell's back / Browse swipe);
 *  - on a text field, or with more than one finger;
 *  - when the gesture is mostly vertical (the list scrolls instead — rows use
 *    `touch-action: pan-y`, so the browser keeps vertical scrolling itself).
 *
 * Reduced motion (OS setting or Settings → Appearance → Reduce motion): the row
 * does not slide; the action label appears in place and the release still acts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "../motion";
import "./swipe.css";

export interface SwipeAction {
  label: string;
  run: () => void;
  tone?: "accent" | "neutral";
}
interface Hint { side: "left" | "right"; label: string; armed: boolean; tone: "accent" | "neutral"; still: boolean }

const EDGE_PX = 24;
const SLOP_PX = 12;
const ARM_PX = 72;
const MAX_PX = 104;

function inSidewaysScroller(target: Element | null): boolean {
  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/**
 * `left` runs when the finger moves LEFT (the row slides left), `right` when it
 * moves right. Returns a ref for the row and the hint element to render inside it.
 */
export function useSwipeActions<T extends HTMLElement>(actions: { left?: SwipeAction | null; right?: SwipeAction | null; disabled?: boolean }): { ref: (el: T | null) => void; hint: ReactNode } {
  const [el, setEl] = useState<T | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const latest = useRef(actions);
  latest.current = actions;
  const ref = useCallback((node: T | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let swiping: "left" | "right" | null = null;
    let armed = false;
    let still = false;
    const reset = (animate: boolean) => {
      start = null;
      swiping = null;
      armed = false;
      el.style.transition = animate && !still ? "transform var(--motion-base, 160ms) ease" : "";
      el.style.transform = "";
      el.removeAttribute("data-swiping");
      setHint(null);
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const a = latest.current;
      if (a.disabled || (!a.left && !a.right) || e.touches.length !== 1 || !t || t.clientX <= EDGE_PX) { start = null; return; }
      const target = e.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], [data-no-swipe]") || inSidewaysScroller(target)) { start = null; return; }
      start = { x: t.clientX, y: t.clientY };
      swiping = null;
      still = prefersReducedMotion();
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      if (e.touches.length !== 1) { reset(false); return; }
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!swiping) {
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx)) { start = null; return; } // a scroll
        if (Math.abs(dx) < SLOP_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const side = dx < 0 ? "left" : "right";
        if (!latest.current[side]) { start = null; return; }
        swiping = side;
        el.setAttribute("data-swiping", side);
        el.style.transition = "";
      }
      const action = latest.current[swiping];
      if (!action || (swiping === "left" ? dx > 0 : dx < 0)) { el.style.transform = ""; armed = false; setHint(null); return; }
      const travel = Math.min(MAX_PX, Math.abs(dx));
      if (!still) el.style.transform = `translateX(${swiping === "left" ? -travel : travel}px)`;
      const nowArmed = travel >= ARM_PX;
      armed = nowArmed;
      setHint((h) => (h && h.side === swiping && h.armed === nowArmed && h.label === action.label ? h : { side: swiping!, label: action.label, armed: nowArmed, tone: action.tone ?? "neutral", still }));
    };
    const onEnd = () => {
      const side = swiping;
      const fire = armed && side ? latest.current[side] : null;
      const swiped = !!side;
      reset(true);
      if (swiped) {
        // The finger lifting over the row would otherwise open it.
        const swallow = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
        el.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => el.removeEventListener("click", swallow, true), 350);
      }
      fire?.run();
    };
    const onCancel = () => reset(false);
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, [el]);

  return {
    ref,
    hint: hint ? (
      <span className="prism-swipe-hint" data-side={hint.side} data-armed={hint.armed || undefined} data-tone={hint.tone} data-still={hint.still || undefined} aria-hidden="true">{hint.label}</span>
    ) : null,
  };
}
