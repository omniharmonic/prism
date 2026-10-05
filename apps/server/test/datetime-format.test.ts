/**
 * Regional preferences (NP-AX-09): the one date/time formatting module of the client
 * (`@prism/core/datetime`). Pure — exercised here across locales, time zones and DST.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDayDiff, formatDate, formatDateTime, formatRelativeDate, formatTime, localeWeekStart,
  relativeDay, weekColumn, weekStartsOn, weekdayOrder, type FormatContext, type RegionPrefs,
} from "@prism/core/datetime";
import { adoptSyncedRegion, getRegionPrefs, getStoredRegion, resetRegionPrefsForTests, sanitizeRegion, setRegionPrefs } from "@prism/core/datetime-preferences";
import { sanitizePreferences } from "@prism/core/pages";

const SYSTEM: RegionPrefs = { weekStart: "system", dateFormat: "system", timeFormat: "system" };
const ctx = (prefs: Partial<RegionPrefs>, more: Partial<FormatContext> = {}): FormatContext => ({ prefs: { ...SYSTEM, ...prefs }, ...more });
const D = new Date("2026-10-04T15:05:09Z"); // a Sunday
const UTC = { timeZone: "UTC" } as const;
const LOCALES = ["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "ar-EG", "pt-BR"];
const OPTIONS: Array<Intl.DateTimeFormatOptions | undefined> = [
  undefined,
  { ...UTC },
  { month: "short", day: "numeric", ...UTC },
  { month: "short", day: "numeric", year: "numeric", ...UTC },
  { weekday: "long", month: "long", day: "numeric", year: "numeric", ...UTC },
  { month: "long", year: "numeric", ...UTC },
  { weekday: "short", ...UTC },
  { dateStyle: "medium", ...UTC },
  { hour: "numeric", minute: "2-digit", ...UTC },
  { dateStyle: "medium", timeStyle: "short", ...UTC },
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...UTC },
];

test("system preferences: every helper returns exactly what toLocale…String returned", () => {
  for (const locale of [undefined, ...LOCALES]) for (const options of OPTIONS) {
    const c = ctx({}, { locale });
    const dateOnly = options && ("hour" in options || "timeStyle" in options) ? undefined : options;
    const timeOnly = options && ("month" in options || "dateStyle" in options || "weekday" in options || "year" in options) ? undefined : options;
    if (dateOnly !== undefined || options === undefined) assert.equal(formatDate(D, dateOnly, c), D.toLocaleDateString(locale, dateOnly));
    if (timeOnly !== undefined || options === undefined) assert.equal(formatTime(D, timeOnly, c), D.toLocaleTimeString(locale, timeOnly));
    assert.equal(formatDateTime(D, options, c), D.toLocaleString(locale, options));
  }
});

test("date format: the preference writes day, month and year; the options choose the parts", () => {
  const full = { month: "short", day: "numeric", year: "numeric", ...UTC } as const;
  const noYear = { month: "short", day: "numeric", ...UTC } as const;
  for (const locale of LOCALES) {
    assert.equal(formatDate(D, full, ctx({ dateFormat: "iso" }, { locale })), "2026-10-04");
    assert.equal(formatDate(D, full, ctx({ dateFormat: "dmy" }, { locale })), "04/10/2026");
    assert.equal(formatDate(D, full, ctx({ dateFormat: "mdy" }, { locale })), "10/04/2026");
    assert.equal(formatDate(D, full, ctx({ dateFormat: "long" }, { locale })), "Oct 4, 2026");
    assert.equal(formatDate(D, noYear, ctx({ dateFormat: "iso" }, { locale })), "10-04");
    assert.equal(formatDate(D, noYear, ctx({ dateFormat: "dmy" }, { locale })), "04/10");
    assert.equal(formatDate(D, noYear, ctx({ dateFormat: "mdy" }, { locale })), "10/04");
    assert.equal(formatDate(D, noYear, ctx({ dateFormat: "long" }, { locale })), "Oct 4");
  }
  // No options = a full numeric date.
  assert.equal(formatDate(new Date(2026, 9, 4, 12), undefined, ctx({ dateFormat: "iso" })), "2026-10-04");
  // A weekday the call site asked for stays, in the call site's locale.
  assert.equal(formatDate(D, { weekday: "long", month: "long", day: "numeric", year: "numeric", ...UTC }, ctx({ dateFormat: "iso" }, { locale: "en-US" })), "Sunday, 2026-10-04");
  assert.equal(formatDate(D, { weekday: "long", month: "long", day: "numeric", year: "numeric", ...UTC }, ctx({ dateFormat: "long" }, { locale: "en-US" })), "Sunday, October 4, 2026");
  assert.equal(formatDate(D, { weekday: "short", month: "short", day: "numeric", ...UTC }, ctx({ dateFormat: "dmy" }, { locale: "de-DE" })), "So, 04/10");
  assert.equal(formatDate(D, { dateStyle: "medium", ...UTC }, ctx({ dateFormat: "mdy" })), "10/04/2026");
  // Not a date in a format: a month heading, a weekday name.
  for (const options of [{ month: "long", year: "numeric", ...UTC }, { weekday: "long", ...UTC }] as Intl.DateTimeFormatOptions[]) {
    assert.equal(formatDate(D, options, ctx({ dateFormat: "iso" }, { locale: "en-US" })), D.toLocaleDateString("en-US", options));
  }
  // An invalid date reads as the runtime says, never "NaN-NaN-NaN".
  assert.equal(formatDate("nope", undefined, ctx({ dateFormat: "iso" })), new Date("nope").toLocaleDateString());
});

test("date format: the calendar day is taken in the option's time zone", () => {
  const late = new Date("2026-10-05T03:30:00Z"); // still the 4th in Denver, already the 5th in Tokyo
  assert.equal(formatDate(late, { year: "numeric", month: "short", day: "numeric", timeZone: "America/Denver" }, ctx({ dateFormat: "iso" })), "2026-10-04");
  assert.equal(formatDate(late, { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Tokyo" }, ctx({ dateFormat: "iso" })), "2026-10-05");
  assert.equal(formatDate(late, { year: "numeric", month: "short", day: "numeric", timeZone: "America/Denver" }, ctx({ dateFormat: "long" })), "Oct 4, 2026");
});

test("time format: 12-hour and 24-hour in every locale, midnight and noon included", () => {
  const opts = { hour: "numeric", minute: "2-digit", ...UTC } as const;
  const digits = (s: string) => s.replace(/[^\d:]/g, "");
  for (const locale of ["en-US", "en-GB", "de-DE", "fr-FR", "pt-BR"]) {
    assert.equal(digits(formatTime(D, opts, ctx({ timeFormat: "24" }, { locale }))), "15:05", locale);
    assert.equal(digits(formatTime(D, opts, ctx({ timeFormat: "12" }, { locale }))), "3:05", locale);
    assert.equal(digits(formatTime(new Date("2026-10-04T00:07:00Z"), opts, ctx({ timeFormat: "24" }, { locale }))).replace(/^0?0:/, "0:"), "0:07", locale);
    assert.equal(digits(formatTime(new Date("2026-10-04T00:07:00Z"), opts, ctx({ timeFormat: "12" }, { locale }))), "12:07", locale);
    assert.equal(digits(formatTime(new Date("2026-10-04T12:07:00Z"), opts, ctx({ timeFormat: "12" }, { locale }))), "12:07", locale);
  }
  assert.match(formatTime(D, opts, ctx({ timeFormat: "12" }, { locale: "en-US" })), /^3:05\sPM$/);
  assert.equal(formatTime(D, opts, ctx({ timeFormat: "24" }, { locale: "en-US" })), "15:05");
  // A call site's own hour12 does not beat the person's choice.
  assert.equal(formatTime(D, { ...opts, hour12: true }, ctx({ timeFormat: "24" }, { locale: "en-US" })), "15:05");
});

test("time format across DST: the wall clock of the zone, both sides of each change", () => {
  const opts = { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" } as const;
  const c = ctx({ timeFormat: "24" }, { locale: "en-US" });
  assert.equal(formatTime(new Date("2026-03-08T08:30:00Z"), opts, c), "01:30"); // MST, before the jump
  assert.equal(formatTime(new Date("2026-03-08T09:30:00Z"), opts, c), "03:30"); // MDT, 02:xx does not exist
  assert.equal(formatTime(new Date("2026-11-01T07:30:00Z"), opts, c), "01:30"); // MDT
  assert.equal(formatTime(new Date("2026-11-01T08:30:00Z"), opts, c), "01:30"); // MST, the repeated hour
});

test("date + time: both preferences, and each alone", () => {
  const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...UTC } as const;
  assert.equal(formatDateTime(D, opts, ctx({ dateFormat: "iso", timeFormat: "24" }, { locale: "en-US" })), "10-04, 15:05");
  assert.match(formatDateTime(D, opts, ctx({ dateFormat: "dmy" }, { locale: "en-US" })), /^04\/10, 3:05\sPM$/);
  assert.equal(formatDateTime(D, { ...opts, year: "numeric" }, ctx({ dateFormat: "long", timeFormat: "24" }, { locale: "en-US" })), "Oct 4, 2026, 15:05");
  // Only the clock chosen: the locale still lays the string out.
  assert.equal(formatDateTime(D, opts, ctx({ timeFormat: "24" }, { locale: "en-US" })), D.toLocaleString("en-US", { ...opts, hourCycle: "h23" }));
  // No options = date and time with seconds, like toLocaleString().
  assert.match(formatDateTime(new Date(2026, 9, 4, 15, 5, 9), undefined, ctx({ dateFormat: "iso", timeFormat: "24" }, { locale: "en-US" })), /^2026-10-04, 15:05:09$/);
  // Date-only options stay date-only; time-only options stay time-only.
  assert.equal(formatDateTime(D, { dateStyle: "medium", ...UTC }, ctx({ dateFormat: "iso", timeFormat: "24" })), "2026-10-04");
  assert.equal(formatDateTime(D, { hour: "numeric", minute: "2-digit", ...UTC }, ctx({ dateFormat: "iso", timeFormat: "24" }, { locale: "en-US" })), "15:05");
});

test("week start: the choice, else the locale", () => {
  assert.equal(weekStartsOn(ctx({ weekStart: "sunday" }, { locale: "de-DE" })), 0);
  assert.equal(weekStartsOn(ctx({ weekStart: "monday" }, { locale: "en-US" })), 1);
  assert.equal(weekStartsOn(ctx({}, { locale: "en-US" })), 0);
  assert.equal(weekStartsOn(ctx({}, { locale: "en-GB" })), 1);
  assert.equal(weekStartsOn(ctx({}, { locale: "de-DE" })), 1);
  assert.equal(weekStartsOn(ctx({}, { locale: "ja-JP" })), 0);
  assert.equal(localeWeekStart("ar-EG"), 6);
  assert.equal(localeWeekStart("not a locale"), 0);
  assert.deepEqual(weekdayOrder(ctx({ weekStart: "monday" })), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(weekdayOrder(ctx({ weekStart: "sunday" })), [0, 1, 2, 3, 4, 5, 6]);
  const sunday = new Date(2026, 9, 4, 12);
  assert.equal(weekColumn(sunday, ctx({ weekStart: "sunday" })), 0);
  assert.equal(weekColumn(sunday, ctx({ weekStart: "monday" })), 6);
});

test("relative days are calendar days — also across a DST change and near midnight", () => {
  const zone = "America/Denver";
  // 2026-03-08 has 23 hours in Denver: 00:30 the next day is "Tomorrow" though only 22.5 h away.
  const now = new Date("2026-03-08T09:00:00Z"); // 03:00 MDT on the 8th
  assert.equal(relativeDay(new Date("2026-03-09T06:30:00Z"), { now, timeZone: zone }), "Tomorrow");
  assert.equal(relativeDay(new Date("2026-03-08T06:59:00Z"), { now, timeZone: zone }), "Yesterday"); // 23:59 MST on the 7th
  assert.equal(relativeDay(new Date("2026-03-08T07:00:00Z"), { now, timeZone: zone }), "Today");
  // 2026-11-01 has 25 hours: 23:30 that day is still "Today" from 00:10.
  const fall = new Date("2026-11-01T06:10:00Z");
  assert.equal(relativeDay(new Date("2026-11-02T06:30:00Z"), { now: fall, timeZone: zone }), "Today");
  assert.equal(relativeDay(new Date("2026-11-02T07:00:00Z"), { now: fall, timeZone: zone }), "Tomorrow");
  assert.equal(calendarDayDiff(new Date("2026-11-08T12:00:00Z"), { now: fall, timeZone: zone }), 7);
  assert.equal(relativeDay(new Date("2026-11-08T12:00:00Z"), { now: fall, timeZone: zone }), null);
  assert.equal(relativeDay("nope", { now }), null);
  // The same instant is another day in another zone.
  assert.equal(relativeDay(new Date("2026-03-08T23:30:00Z"), { now, timeZone: "Asia/Tokyo" }), "Tomorrow");
  assert.equal(formatRelativeDate(new Date("2026-03-09T06:30:00Z"), { now, timeZone: zone, prefs: { ...SYSTEM, dateFormat: "iso" } }), "Tomorrow");
  assert.equal(formatRelativeDate(new Date("2026-03-20T18:00:00Z"), { now, timeZone: zone, prefs: { ...SYSTEM, dateFormat: "iso" } }), "03-20");
  assert.equal(formatRelativeDate(new Date("2025-03-20T18:00:00Z"), { now, timeZone: zone, prefs: { ...SYSTEM, dateFormat: "iso" } }), "2025-03-20");
});

test("the stored preferences: sanitised, newest wins, and part of the synced document only when set", () => {
  assert.deepEqual(sanitizeRegion({ weekStart: "monday", dateFormat: "nope", timeFormat: "24", at: 5, extra: 1 }), { weekStart: "monday", timeFormat: "24", at: 5 });
  assert.deepEqual(sanitizeRegion("x"), {});
  assert.deepEqual(sanitizeRegion({ weekStart: "system", at: -1 }), {});
  resetRegionPrefsForTests();
  assert.deepEqual(getRegionPrefs(), SYSTEM);
  setRegionPrefs({ dateFormat: "iso" });
  assert.equal(getRegionPrefs().dateFormat, "iso");
  assert.equal(formatDate(new Date(2026, 9, 4, 12), { month: "short", day: "numeric", year: "numeric" }), "2026-10-04");
  const at = getStoredRegion().at!;
  assert.equal(adoptSyncedRegion({ dateFormat: "dmy", at: at - 1 }), false, "an older synced copy never replaces a newer local choice");
  assert.equal(adoptSyncedRegion({ dateFormat: "dmy" }), false, "a copy without a timestamp is not adopted");
  assert.equal(getRegionPrefs().dateFormat, "iso");
  assert.equal(adoptSyncedRegion({ weekStart: "monday", at: at + 1 }), true);
  assert.deepEqual(getRegionPrefs(), { weekStart: "monday", dateFormat: "system", timeFormat: "system" });
  resetRegionPrefsForTests();

  // The synced preferences document keeps `region` only when one was sent (an older client's
  // document stays byte-identical), and only valid values.
  assert.equal("region" in sanitizePreferences({ favorites: ["a"] }), false);
  assert.deepEqual(sanitizePreferences({ region: { weekStart: "monday", dateFormat: "<script>", at: 9 } }).region, { weekStart: "monday", at: 9 });
  assert.deepEqual(sanitizePreferences({ region: {} }).region, {});
  assert.equal("region" in sanitizePreferences({ region: "monday" }), false);
});
