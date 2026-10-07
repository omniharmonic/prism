import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { formatDate, formatTime, usesSystemDate, usesSystemTime } from "../../lib/datetime/format";
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

// With the regional preferences on "system" these are the strings history always showed
// (date-fns patterns); a chosen date or time format replaces that part (NP-AX-09).
const clock = (d: Date): string => (usesSystemTime() ? format(d, "h:mm a") : formatTime(d, { hour: "numeric", minute: "2-digit" }));
const monthDay = (d: Date, year: boolean): string =>
  usesSystemDate() ? format(d, year ? "MMM d, yyyy" : "MMM d") : formatDate(d, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (isToday(d)) return `Today, ${clock(d)}`;
  if (isYesterday(d)) return `Yesterday, ${clock(d)}`;
  return `${monthDay(d, d.getFullYear() !== new Date().getFullYear())}, ${clock(d)}`;
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
  const year = d.getFullYear() !== new Date().getFullYear();
  return year ? monthDay(d, true) : `${format(d, "EEEE")}, ${monthDay(d, false)}`;
}

/** Signed character-count change, e.g. "+1.2k" / "−40" / "±0". */
export function sizeDelta(before: number, after: number): { text: string; sign: -1 | 0 | 1 } {
  const d = after - before;
  if (d === 0) return { text: "±0", sign: 0 };
  const abs = Math.abs(d);
  const n = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k` : String(abs);
  return d > 0 ? { text: `+${n}`, sign: 1 } : { text: `−${n}`, sign: -1 };
}
