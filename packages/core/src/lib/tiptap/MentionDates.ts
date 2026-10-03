/**
 * Date mentions (NP-RF-05): parse what the user types after `@` into date
 * candidates, and show a stored date chip relatively ("Today", "Tomorrow 9:00").
 *
 * Storage format (`data-date`):
 *   date only → "YYYY-MM-DD" (a calendar day, the same day in every time zone)
 *   timed     → an ISO instant with the author's offset, "2026-10-03T09:00:00-06:00"
 *               (shown in each reader's own time zone).
 * Pure: `now` is injected so tests and the fixture clock control it.
 */

export interface DateCandidate {
  /** Menu label, e.g. "Tomorrow 9:00" or "Friday, Oct 9". */
  label: string;
  /** Value for `data-date`. */
  date: string;
  dateOnly: boolean;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as YYYY-MM-DD. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local wall time as an ISO string with this machine's offset. */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const isDateOnly = (value: string | null | undefined): boolean => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** A stored chip date → a Date (date-only = local midnight of that day). */
export function chipDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (isDateOnly(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const out = new Date(y!, m! - 1, d!);
    return Number.isNaN(out.getTime()) ? null : out;
  }
  const out = new Date(value);
  return Number.isNaN(out.getTime()) ? null : out;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function timeLabel(d: Date): string {
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

/** Relative display for a chip: "Today", "Tomorrow 9:00", "Yesterday", "Friday", "Oct 9", "Oct 9, 2027". */
export function formatChipDate(value: string | null | undefined, now: Date = new Date()): string {
  const d = chipDate(value);
  if (!d) return "Date";
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const timed = !isDateOnly(value);
  let day: string;
  if (days === 0) day = "Today";
  else if (days === 1) day = "Tomorrow";
  else if (days === -1) day = "Yesterday";
  else if (days > 1 && days < 7) day = d.toLocaleDateString(undefined, { weekday: "long" });
  else day = d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return timed ? `${day} ${timeLabel(d)}` : day;
}

/** Full, unambiguous label for tooltips / screen readers. */
export function formatChipDateLong(value: string | null | undefined): string {
  const d = chipDate(value);
  if (!d) return "Date";
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  if (!isDateOnly(value)) Object.assign(opts, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return d.toLocaleString(undefined, opts);
}

/** "9", "9am", "9:30", "14:00", "9.30pm" → [h, m] or null. */
function parseTime(text: string): [number, number] | null {
  const m = text.trim().match(/^(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return [h, min];
}

function dayFrom(word: string, now: Date): Date | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  if ("today".startsWith(w) && w.length >= 2) return startOfDay(now);
  if ("tomorrow".startsWith(w) && w.length >= 3) return addDays(now, 1);
  if ("yesterday".startsWith(w) && w.length >= 3) return addDays(now, -1);
  const iso = w.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) || d.getMonth() !== Number(iso[2]) - 1 ? null : d;
  }
  const inDays = w.match(/^in (\d{1,3}) days?$/);
  if (inDays) return addDays(now, Number(inDays[1]));
  const next = w.match(/^(next )?([a-z]{2,9})$/);
  if (next) {
    const idx = WEEKDAYS.findIndex((d) => d.startsWith(next[2]!) && next[2]!.length >= 2);
    if (idx >= 0) {
      // "monday" = the coming Monday (today if it is Monday); "next monday" = strictly after today.
      let delta = (idx - now.getDay() + 7) % 7;
      if (delta === 0 && next[1]) delta = 7;
      return addDays(now, delta);
    }
  }
  return null;
}

/**
 * Candidates for what follows `@`. "tom" → Tomorrow; "tomorrow 9am" → Tomorrow 9:00;
 * "next mon" → that Monday; "2026-10-03" → that day. An empty query offers
 * Today and Tomorrow.
 */
export function parseDateQuery(query: string, now: Date = new Date()): DateCandidate[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const make = (d: Date, time: [number, number] | null): DateCandidate => {
    if (!time) return { label: formatChipDate(ymd(d), now), date: ymd(d), dateOnly: true };
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time[0], time[1]);
    const iso = localIso(at);
    return { label: formatChipDate(iso, now), date: iso, dateOnly: false };
  };
  if (!q) return [make(startOfDay(now), null), make(addDays(now, 1), null)];
  const out: DateCandidate[] = [];
  const whole = dayFrom(q, now);
  if (whole) out.push(make(whole, null));
  else {
    // "<day> <time>" — try every split point from the right.
    const parts = q.split(" ");
    for (let i = parts.length - 1; i >= 1 && !out.length; i--) {
      const day = dayFrom(parts.slice(0, i).join(" "), now);
      const time = parseTime(parts.slice(i).join(" "));
      if (day && time) out.push(make(day, time));
    }
    if (!out.length) {
      const time = parseTime(q);
      if (time && /\d/.test(q) && (/[ap]m?$|:/.test(q))) out.push(make(startOfDay(now), time));
    }
  }
  return out.slice(0, 3);
}
