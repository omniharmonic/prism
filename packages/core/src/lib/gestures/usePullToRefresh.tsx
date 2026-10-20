/**
 * Pull-to-refresh for phone lists (NP-MB-06): Inbox, Messages, Trash, the page tree.
 *
 * Drag the list down from its top; past ~64 px the indicator arms, and releasing
 * runs the list's EXISTING refetch (no new server calls). Touch events only, so a
 * mouse or trackpad never triggers it.
 *
 * Never starts:
 *  - unless the scroller (and every scroller between it and the finger) is at its top;
 *  - while a text field has focus, or when the touch begins on one;
 *  - inside a sideways scroller (a board, a table — it owns its own drag);
 *  - with more than one finger, or for a mostly sideways drag (row swipes).
 *
 * The scroller gets `overscroll-behavior-y: contain`, so the browser's own
 * pull-to-refresh / overscroll glow never runs alongside ours (listeners stay passive).
 * Reduced motion: nothing follows the finger and nothing spins — the label shows in place.
 * The outcome is announced politely to screen readers.
 *
 * A gesture is never the only way: every list also has a "Refresh" button that calls
 * the returned `refresh()` (same state, same announcement).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "../motion";
import "./pull.css";

const SLOP_PX = 10;
/** Finger travel is damped by half, so the indicator arms after ~128 px of finger = 64 px of pull. */
const DAMPING = 0.5;
export const PULL_ARM_PX = 64;
const MAX_PX = 96;
const TEXT_FIELD = "input, textarea, select, [contenteditable=''], [contenteditable=true]";

type Phase = "idle" | "pulling" | "armed" | "refreshing" | "done" | "failed";

function inSidewaysScroller(target: Element | null, stop: Element): boolean {
  for (let node: Element | null = target; node && node !== stop && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}
/** A nested vertical scroller between the finger and the list that is not at its top owns the drag. */
function nestedScrolled(target: Element | null, stop: Element): boolean {
  for (let node: Element | null = target; node && node !== stop && node !== document.body; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
  }
  return false;
}

export function usePullToRefresh<T extends HTMLElement>(options: {
  /** The list's existing refetch. A rejected promise reads "Couldn’t refresh". */
  onRefresh: () => Promise<unknown> | unknown;
  disabled?: boolean;
  /** What is being refreshed, for the announcement ("Inbox updated"). */
  label?: string;
}): { ref: (el: T | null) => void; indicator: ReactNode; refreshing: boolean; refresh: () => void } {
  const [el, setEl] = useState<T | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pull, setPull] = useState(0);
  const [still, setStill] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ref = useCallback((node: T | null) => setEl(node), []);

  const refresh = useCallback(() => {
    if (busy.current || latest.current.disabled) return;
    busy.current = true;
    setStill(prefersReducedMotion());
    setPull(0);
    setPhase("refreshing");
    const settle = (next: Phase) => {
      busy.current = false;
      if (!mounted.current) return;
      setPhase(next);
      window.setTimeout(() => { if (mounted.current) setPhase((p) => (p === next ? "idle" : p)); }, 1600);
    };
    let run: Promise<unknown>;
    try { run = Promise.resolve(latest.current.onRefresh()); } catch (e) { run = Promise.reject(e); }
    // A TanStack `refetch()` resolves with `{isError}` instead of rejecting.
    run.then((r) => settle(r && typeof r === "object" && (r as { isError?: unknown }).isError === true ? "failed" : "done"), () => settle("failed"));
  }, []);

  useEffect(() => {
    if (!el) return;
    el.classList.add("prism-ptr-scroller");
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let armed = false;
    const reset = () => {
      start = null;
      if (pulling) { pulling = false; armed = false; setPull(0); setPhase((p) => (p === "pulling" || p === "armed" ? "idle" : p)); }
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = null;
      if (latest.current.disabled || busy.current || e.touches.length !== 1 || !t || el.scrollTop > 0) return;
      const target = e.target as Element | null;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches(TEXT_FIELD)) return;
      if (target?.closest?.(`${TEXT_FIELD}, [data-no-pull]`)) return;
      if (inSidewaysScroller(target, el) || nestedScrolled(target, el)) return;
      start = { x: t.clientX, y: t.clientY };
      pulling = false;
      armed = false;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      if (e.touches.length !== 1 || el.scrollTop > 0) { reset(); return; }
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!pulling) {
        if (dy < -SLOP_PX || (Math.abs(dx) > SLOP_PX && Math.abs(dx) >= Math.abs(dy))) { start = null; return; } // a scroll up, or a row swipe
        if (dy < SLOP_PX || dy < Math.abs(dx) * 1.5) return;
        pulling = true;
        setStill(prefersReducedMotion());
      }
      const travel = Math.max(0, Math.min(MAX_PX, (dy - SLOP_PX) * DAMPING));
      armed = travel >= PULL_ARM_PX;
      setPull(travel);
      setPhase(armed ? "armed" : "pulling");
    };
    const onEnd = () => {
      const fire = pulling && armed;
      reset();
      if (fire) refresh();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", reset);
    return () => {
      el.classList.remove("prism-ptr-scroller");
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
    };
  }, [el, refresh]);

  const what = options.label ?? "List";
  const text = phase === "pulling" ? "Pull to refresh" : phase === "armed" ? "Release to refresh" : phase === "refreshing" ? "Refreshing…" : phase === "done" ? "Updated" : phase === "failed" ? "Couldn’t refresh" : "";
  const said = phase === "refreshing" ? `Refreshing ${what.toLowerCase()}…` : phase === "done" ? `${what} updated` : phase === "failed" ? `Couldn’t refresh ${what.toLowerCase()}` : "";
  const offset = phase === "pulling" || phase === "armed" ? pull : phase === "idle" ? 0 : 40;
  return {
    ref,
    refreshing: phase === "refreshing",
    refresh,
    // First child of the scroller: a zero-height sticky anchor, so it needs no positioned ancestor.
    indicator: (
      <div className="prism-ptr" data-state={phase} data-still={still || undefined} data-testid="pull-to-refresh">
        {phase !== "idle" && (
          <span className="prism-ptr-pill" aria-hidden="true" style={still ? undefined : { transform: `translate(-50%, ${Math.round(offset)}px)`, opacity: Math.min(1, 0.35 + offset / PULL_ARM_PX) }}>
            <span className="prism-ptr-spin" />
            {text}
          </span>
        )}
        {/* Always mounted, so the announcement is reliable; `aria-live` without a role keeps it out of `getByRole("status")` look-ups elsewhere. */}
        <span className="prism-ptr-status" aria-live="polite" aria-atomic="true">{said}</span>
      </div>
    ),
  };
}
