/**
 * THE date/time formatting module (NP-AX-09). Every surface that shows a date or a clock
 * time goes through these helpers so the three regional preferences (Settings → Appearance →
 * Language & region) apply everywhere:
 *
 *   formatDate / formatTime / formatDateTime — drop-in for `toLocaleDateString` /
 *   `toLocaleTimeString` / `toLocaleString`: SAME arguments (options, then a context that
 *   may carry the locale the call site used). With a preference on "system" the result is
 *   byte-for-byte what the `toLocale…` call returned, so adopting a helper changes nothing
 *   until somebody picks a format.
 *
 *   weekStartsOn() — 0 (Sunday) | 1 (Monday) | 6 (Saturday, locale only).
 *   relativeDay()  — "Today" | "Yesterday" | "Tomorrow" | null, by CALENDAR day (DST-safe).
 *
 * Pure: no DOM, no React. `ctx` overrides the stored preferences, the locale, "now" and the
 * time zone (tests; server-side callers).
 */
import { getRegionPrefs, type RegionPrefs } from "./preferences";

export type { RegionPrefs, WeekStartPref, DateFormatPref, TimeFormatPref } from "./preferences";

export type DateInput = Date | number | string;
export interface FormatContext {
  prefs?: RegionPrefs;
  /** The locale the call site formats in (default: the runtime's). */
  locale?: string | string[];
  now?: Date;
  /** IANA zone for relative-day maths (formatting uses `options.timeZone`, like Intl). */
  timeZone?: string;
}
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value));
const prefsOf = (ctx?: FormatContext): RegionPrefs => ctx?.prefs ?? getRegionPrefs();
const pad = (n: number | string, width = 2): string => String(n).padStart(width, "0");

const TIME_KEYS = ["hour", "minute", "second", "fractionalSecondDigits", "timeZoneName", "timeStyle", "hour12", "hourCycle", "dayPeriod"] as const;
const DATE_KEYS = ["weekday", "era", "year", "month", "day", "dateStyle"] as const;
const has = (o: Intl.DateTimeFormatOptions | undefined, keys: readonly string[]): boolean =>
  !!o && keys.some((k) => (o as Record<string, unknown>)[k] !== undefined);
const only = (o: Intl.DateTimeFormatOptions | undefined, keys: readonly string[]): Intl.DateTimeFormatOptions => {
  const out: Record<string, unknown> = {};
  if (!o) return out;
  for (const k of [...keys, "timeZone", "calendar", "numberingSystem"]) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
  return out;
};

/** Calendar parts of an instant in a zone (the runtime's when `timeZone` is undefined). */
function ymd(d: Date, timeZone?: string): { y: number; m: number; d: number } {
  if (!timeZone) return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", calendar: "gregory" }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: n("year"), m: n("month"), d: n("day") };
}

/**
 * A date. `options` are `toLocaleDateString` options; they decide WHICH parts show (year or
 * not, weekday or not) — the preference decides how day, month and year are written.
 * Options without a day ("October 2026", "Monday") are not a date in a format: locale as is.
 */
export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions, ctx?: FormatContext): string {
  const d = toDate(value);
  const { dateFormat } = prefsOf(ctx);
  const noFields = !has(options, DATE_KEYS);
  const wantsDay = noFields || options?.day !== undefined || options?.dateStyle !== undefined;
  if (dateFormat === "system" || !wantsDay || Number.isNaN(d.getTime())) return d.toLocaleDateString(ctx?.locale, options);

  const wantsYear = noFields || options?.year !== undefined || options?.dateStyle !== undefined;
  const longMonth = options?.month === "long" || options?.dateStyle === "long" || options?.dateStyle === "full";
  const weekday = options?.weekday ?? (options?.dateStyle === "full" ? "long" : undefined);
  const zone = options?.timeZone;
  const p = ymd(d, zone);
  let body: string;
  if (dateFormat === "iso") body = wantsYear ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : `${pad(p.m)}-${pad(p.d)}`;
  else if (dateFormat === "dmy") body = wantsYear ? `${pad(p.d)}/${pad(p.m)}/${pad(p.y, 4)}` : `${pad(p.d)}/${pad(p.m)}`;
  else if (dateFormat === "mdy") body = wantsYear ? `${pad(p.m)}/${pad(p.d)}/${pad(p.y, 4)}` : `${pad(p.m)}/${pad(p.d)}`;
  else body = d.toLocaleDateString("en-US", { month: longMonth ? "long" : "short", day: "numeric", ...(wantsYear ? { year: "numeric" } : {}), ...(zone ? { timeZone: zone } : {}) });
  if (!weekday) return body;
  const name = d.toLocaleDateString(ctx?.locale, { weekday, ...(zone ? { timeZone: zone } : {}) });
  return `${name}, ${body}`;
}

/** A clock time. `options` are `toLocaleTimeString` options; the preference sets 12/24-hour. */
export function formatTime(value: DateInput, options?: Intl.DateTimeFormatOptions, ctx?: FormatContext): string {
  const d = toDate(value);
  const { timeFormat } = prefsOf(ctx);
  if (timeFormat === "system" || Number.isNaN(d.getTime())) return d.toLocaleTimeString(ctx?.locale, options);
  const { hour12: _dropped, ...rest } = options ?? {};
  return d.toLocaleTimeString(ctx?.locale, { ...rest, hourCycle: timeFormat === "24" ? "h23" : "h12" });
}

/** A date with a time. `options` are `toLocaleString` options. */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions, ctx?: FormatContext): string {
  const d = toDate(value);
  const prefs = prefsOf(ctx);
  if (Number.isNaN(d.getTime()) || (prefs.dateFormat === "system" && prefs.timeFormat === "system")) return d.toLocaleString(ctx?.locale, options);
  const anyDate = has(options, DATE_KEYS);
  const anyTime = has(options, TIME_KEYS);
  if (prefs.dateFormat === "system") {
    // Only the clock changes: let the locale lay the whole string out.
    if (anyDate && !anyTime) return d.toLocaleString(ctx?.locale, options);
    const { hour12: _dropped, ...rest } = options ?? {};
    return d.toLocaleString(ctx?.locale, { ...rest, hourCycle: prefs.timeFormat === "24" ? "h23" : "h12" });
  }
  // `toLocaleString()` with no fields = numeric date + time with seconds; with fields = those fields.
  const date = anyDate ? formatDate(d, only(options, DATE_KEYS), ctx) : anyTime ? "" : formatDate(d, only(options, []), ctx);
  const time = anyTime ? formatTime(d, only(options, TIME_KEYS), ctx) : anyDate ? "" : formatTime(d, only(options, []), ctx);
  return date && time ? `${date}, ${time}` : date || time;
}

// ── week start ──────────────────────────────────────────────────────────────

/** Regions whose week starts on Sunday / Saturday (CLDR), for runtimes without `Intl.Locale#weekInfo`. */
const SUNDAY_FIRST = new Set("AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(" "));
const SATURDAY_FIRST = new Set("AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "));

const runtimeLocale = (): string => {
  try { return (typeof navigator !== "undefined" && navigator.language) || new Intl.DateTimeFormat().resolvedOptions().locale || "en-US"; } catch { return "en-US"; }
};

/** First day of the week in a locale: 0 Sunday · 1 Monday · 6 Saturday. */
export function localeWeekStart(locale?: string | string[]): Weekday {
  const tag = (Array.isArray(locale) ? locale[0] : locale) || runtimeLocale();
  try {
    const loc = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    if (typeof first === "number" && first >= 1 && first <= 7) return (first % 7) as Weekday;
    const region = (loc.maximize?.().region ?? loc.region ?? "").toUpperCase();
    if (SUNDAY_FIRST.has(region)) return 0;
    if (SATURDAY_FIRST.has(region)) return 6;
    return 1;
  } catch {
    return 0;
  }
}

/** The first day of the week every calendar grid starts on. */
export function weekStartsOn(ctx?: FormatContext): Weekday {
  const { weekStart } = prefsOf(ctx);
  if (weekStart === "sunday") return 0;
  if (weekStart === "monday") return 1;
  return localeWeekStart(ctx?.locale);
}

/** The seven weekdays (0 = Sunday) in display order. */
export function weekdayOrder(ctx?: FormatContext): Weekday[] {
  const first = weekStartsOn(ctx);
  return Array.from({ length: 7 }, (_, i) => ((first + i) % 7) as Weekday);
}

/** Column (0–6) of a date in a week row that starts on `weekStartsOn()`. */
export function weekColumn(value: DateInput, ctx?: FormatContext): number {
  return (toDate(value).getDay() - weekStartsOn(ctx) + 7) % 7;
}

// ── relative days ───────────────────────────────────────────────────────────

/** Whole CALENDAR days from today to `value` (−1 = yesterday). Never a 23/25-hour day off across DST. */
export function calendarDayDiff(value: DateInput, ctx?: FormatContext): number {
  const a = ymd(toDate(value), ctx?.timeZone);
  const b = ymd(ctx?.now ?? new Date(), ctx?.timeZone);
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000);
}

export type RelativeDay = "Today" | "Yesterday" | "Tomorrow";
export function relativeDay(value: DateInput, ctx?: FormatContext): RelativeDay | null {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return null;
  const diff = calendarDayDiff(d, ctx);
  return diff === 0 ? "Today" : diff === -1 ? "Yesterday" : diff === 1 ? "Tomorrow" : null;
}

/** "Today" / "Yesterday" / "Tomorrow", else the date in the chosen format (year only when it differs). */
export function formatRelativeDate(value: DateInput, ctx?: FormatContext): string {
  const d = toDate(value);
  const rel = relativeDay(d, ctx);
  if (rel) return rel;
  const sameYear = ymd(d, ctx?.timeZone).y === ymd(ctx?.now ?? new Date(), ctx?.timeZone).y;
  return formatDate(d, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...(ctx?.timeZone ? { timeZone: ctx.timeZone } : {}) }, ctx);
}

/** True when the preference leaves dates / times exactly as the call site wrote them. */
export const usesSystemDate = (ctx?: FormatContext): boolean => prefsOf(ctx).dateFormat === "system";
export const usesSystemTime = (ctx?: FormatContext): boolean => prefsOf(ctx).timeFormat === "system";
