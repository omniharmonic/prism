import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import type { NoteVersionSummary } from "../../data/VaultClient";

/** What replaced a version, phrased for the timeline ("…then it was edited"). */
export function opLabel(op: string): string {
  switch (op) {
    case "update":
      return "edited";
    case "delete":
      return "deleted";
    case "restore":
      return "replaced by a restore";
    case "tag-rename":
      return "tag renamed";
    case "cascade-rename":
      return "a linked note was renamed";
    case "import":
      return "imported";
    default:
      return op;
  }
}

/**
 * When a version's content was written: the moment the NEXT-OLDER version was
 * superseded. The oldest captured version predates history, so it has none.
 * `versions` is newest-first, as the vault returns it.
 */
export function savedAt(versions: NoteVersionSummary[], i: number): string | null {
  return versions[i + 1]?.supersededAt ?? null;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (isToday(d)) return `Today, ${format(d, "h:mm a")}`;
  if (isYesterday(d)) return `Yesterday, ${format(d, "h:mm a")}`;
  return format(d, d.getFullYear() === new Date().getFullYear() ? "MMM d, h:mm a" : "MMM d, yyyy, h:mm a");
}

export function ago(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatDistanceToNow(d, { addSuffix: true });
}

/** Day bucket for grouping the timeline. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, d.getFullYear() === new Date().getFullYear() ? "EEEE, MMM d" : "MMM d, yyyy");
}

/** Signed character-count change, e.g. "+1.2k" / "−40" / "±0". */
export function sizeDelta(before: number, after: number): { text: string; sign: -1 | 0 | 1 } {
  const d = after - before;
  if (d === 0) return { text: "±0", sign: 0 };
  const abs = Math.abs(d);
  const n = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k` : String(abs);
  return d > 0 ? { text: `+${n}`, sign: 1 } : { text: `−${n}`, sign: -1 };
}
