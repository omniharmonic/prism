import { useSyncExternalStore } from "react";

/**
 * In-app "Reduce motion" (NP-AX-06). Device-local, like the theme: stored in
 * localStorage and applied as `html.reduce-motion`, which `styles/shell.css`
 * treats exactly like `prefers-reduced-motion: reduce`.
 */
const KEY = "prism:reduce-motion";
const listeners = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function applyReduceMotion(on = read()): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("reduce-motion", on);
}

export function setReduceMotion(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* private mode: class only */ }
  applyReduceMotion(on);
  listeners.forEach((fn) => fn());
}

export function useReduceMotion(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => document.documentElement.classList.contains("reduce-motion"),
    () => false,
  );
  return [value, setReduceMotion];
}

/** True when either the OS or the in-app setting asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.classList.contains("reduce-motion")
    || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The positions of a damped spring travelling from `from` to `to`, one per display frame, with the
 * time they span. Hand the values to the Web Animations API as linear keyframes: the spring is in
 * the values, so a release carries its `velocity` (px/s) into the motion instead of restarting an
 * easing curve from rest. The defaults settle without overshoot in roughly a fifth of a second;
 * `maxMs` bounds it (the app's entrances stay within 320 ms).
 */
export function springFrames(from: number, to: number, options: { stiffness?: number; damping?: number; velocity?: number; maxMs?: number } = {}): { values: number[]; duration: number } {
  const stiffness = options.stiffness ?? 420;
  const damping = options.damping ?? 38;
  const maxMs = options.maxMs ?? 320;
  const step = 1 / 240; // four solver steps per 60 Hz frame keeps the integration stable
  const values = [from];
  let x = from;
  let v = options.velocity ?? 0;
  for (let i = 1; (i * step * 1000) <= maxMs; i++) {
    v += (-stiffness * (x - to) - damping * v) * step;
    x += v * step;
    if (i % 4) continue;
    if (Math.abs(x - to) < 0.5 && Math.abs(v) < 12) break;
    values.push(x);
  }
  values.push(to);
  return { values, duration: Math.min(maxMs, Math.max(100, Math.round((values.length - 1) * (1000 / 60)))) };
}

if (typeof document !== "undefined") applyReduceMotion();
