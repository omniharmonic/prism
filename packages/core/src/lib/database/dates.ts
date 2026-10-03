/**
 * Date property values — PURE, no imports (shared by the query engine, the
 * editors and the calendar).
 *
 * A date property is a string in one of three shapes:
 *   `YYYY-MM-DD`                       a day
 *   `YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]`  a time (zoned = an instant; zone-less = wall time)
 *   `<start>/<end>`                    a range (ISO 8601 interval) of two of the above
 *
 * Every function here is linear in the length of its input.
 */

const ISO_ONE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}[\d:.]*(Z|[+-]\d{2}:?\d{2})?)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/;

/** `start/end` → its two ends; anything else → null. */
export function dateRange(s: string): [string, string] | null {
  if (s.length > 80) return null;
  const at = s.indexOf("/");
  if (at < 10 || at !== s.lastIndexOf("/")) return null;
  const a = s.slice(0, at);
  const b = s.slice(at + 1);
  return ISO_ONE.test(a) && ISO_ONE.test(b) ? [a, b] : null;
}

export const isDateValue = (s: string): boolean => ISO_ONE.test(s) || dateRange(s) !== null;
export const hasTime = (s: string): boolean => s.length > 10 && !DAY.test(s);

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The VIEWER's local day of one date/datetime (a zoned instant is converted; anything else is taken as written). */
export function localDayOf(s: string): string {
  if (s.length > 10 && ZONED.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (!Number.isNaN(t)) return ymd(new Date(t));
  }
  return s.slice(0, 10);
}
/** The viewer's local `HH:MM` of a datetime (null for a plain day). */
export function localTimeOf(s: string): string | null {
  if (!hasTime(s)) return null;
  if (ZONED.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (!Number.isNaN(t)) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  }
  return s.slice(11, 16);
}

/** The local days a value covers: `[first, last]` (equal for a single date). Null when it is not a date. */
export function daySpan(v: string): [string, string] | null {
  const r = dateRange(v);
  if (r) {
    const a = localDayOf(r[0]);
    const b = localDayOf(r[1]);
    return a <= b ? [a, b] : [b, a];
  }
  if (!ISO_ONE.test(v)) return null;
  const d = localDayOf(v);
  return [d, d];
}

/** `YYYY-MM-DD` + n days (calendar arithmetic, no time zone involved). */
export function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export function dayDiff(a: string, b: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

function shiftOne(s: string, days: number): string {
  if (DAY.test(s)) return addDays(s, days);
  if (ZONED.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (Number.isNaN(t)) return s;
    const d = new Date(t);
    d.setDate(d.getDate() + days); // keeps the local wall time across a DST change
    return d.toISOString();
  }
  return addDays(s.slice(0, 10), days) + s.slice(10);
}
/** Move a date value (day, time or range) by whole days, keeping its shape, its time of day and a range's length. */
export function shiftDateValue(v: string, days: number): string {
  if (!days) return v;
  const r = dateRange(v);
  return r ? `${shiftOne(r[0], days)}/${shiftOne(r[1], days)}` : shiftOne(v, days);
}

/** Editor parts of a value (local date + optional local time, optional end). */
export interface DateParts { date: string; time: string | null; endDate: string | null; endTime: string | null }
export function parseDateParts(v: unknown): DateParts | null {
  if (typeof v !== "string") return null;
  const r = dateRange(v);
  const start = r ? r[0] : v;
  if (!ISO_ONE.test(start)) return null;
  return {
    date: localDayOf(start), time: localTimeOf(start),
    endDate: r ? localDayOf(r[1]) : null, endTime: r ? localTimeOf(r[1]) : null,
  };
}
/** Build the stored string. A time is stored as a zoned instant (the viewer's wall time → UTC). */
export function buildDateValue(p: DateParts): string | null {
  const one = (date: string, time: string | null): string | null => {
    if (!DAY.test(date)) return null;
    if (time === null) return date;
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    const d = new Date(`${date}T${time}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const start = one(p.date, p.time);
  if (!start) return null;
  if (p.endDate === null) return start;
  const end = one(p.endDate, p.time === null ? null : p.endTime ?? p.time);
  if (!end) return null;
  return `${start}/${end}`;
}
