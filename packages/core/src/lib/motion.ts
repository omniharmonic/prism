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

if (typeof document !== "undefined") applyReduceMotion();
