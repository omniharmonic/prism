import { formatDate as fmtDate } from "./datetime/format";
/** Shortcut hints shown beside commands and buttons (NP-SR-06): ⌘ on Apple devices, Ctrl elsewhere. */
const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

/** `hint("mod", "shift", "L")` → "⌘⇧L" or "Ctrl+Shift+L". */
export function hint(...keys: string[]): string {
  const map: Record<string, string> = apple ? { mod: "⌘", shift: "⇧", alt: "⌥", enter: "↵" } : { mod: "Ctrl", shift: "Shift", alt: "Alt", enter: "Enter" };
  const parts = keys.map((k) => map[k] ?? k);
  return apple ? parts.join("") : parts.join("+");
}

/** The same shortcut for `aria-keyshortcuts`: "Meta+Shift+L" / "Control+Shift+L". */
export function ariaKeys(...keys: string[]): string {
  const map: Record<string, string> = { mod: apple ? "Meta" : "Control", shift: "Shift", alt: "Alt", enter: "Enter" };
  return keys.map((k) => map[k] ?? k).join("+");
}

/** "Edited today" / "Edited yesterday" / "Edited 3 days ago" / "Edited Sep 30" / "Edited Sep 30, 2025". */
export function editedLabel(updatedAt: string | null | undefined, now = new Date()): string | null {
  if (!updatedAt) return null;
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return "Edited today";
  if (days === 1) return "Edited yesterday";
  if (days < 7) return `Edited ${days} days ago`;
  return `Edited ${fmtDate(at, at.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}`;
}
