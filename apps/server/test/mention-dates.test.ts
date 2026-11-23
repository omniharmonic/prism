/**
 * The @ menu's date words (packages/core/src/lib/tiptap/MentionDates.ts, pure): "monday" is the coming
 * Monday (today when it is Monday), "next monday" the first Monday STRICTLY after today — on every
 * weekday, and across the two daylight-saving changes of the host's zone (the day arithmetic is on
 * calendar days, never on 24-hour steps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
const CORE_TIPTAP = "../../../packages/core/src/lib/tiptap/";
const { parseDateQuery, ymd } = (await import(`${CORE_TIPTAP}MentionDates`)) as {
  parseDateQuery: (query: string, now?: Date) => Array<{ label: string; date: string; dateOnly: boolean }>;
  ymd: (d: Date) => string;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** The calendar day `n` days after `d` (local), by date fields — the definition the product must meet. */
const plusDays = (d: Date, n: number) => ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12));

// Every weekday as "today", at several times of day, in ordinary weeks and in the weeks holding the
// 2026 daylight-saving changes (US: 8 March, 1 November; EU: 29 March, 25 October).
const STARTS = [new Date(2026, 9, 4), new Date(2026, 2, 5), new Date(2026, 2, 26), new Date(2026, 9, 22), new Date(2026, 9, 29), new Date(2026, 11, 28)];
const TIMES: Array<[number, number]> = [[0, 0], [0, 30], [1, 30], [2, 30], [9, 0], [12, 0], [23, 59]];

test("next <weekday> is the first such day strictly after today — all weekdays, all times, across DST", () => {
  let checked = 0;
  for (const start of STARTS) {
    for (let offset = 0; offset < 7; offset++) {
      for (const [h, m] of TIMES) {
        const now = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, h, m);
        for (let target = 0; target < 7; target++) {
          const until = (target - now.getDay() + 7) % 7;
          const next = parseDateQuery(`next ${WEEKDAYS[target]}`, now);
          assert.equal(next.length, 1, `next ${WEEKDAYS[target]} @ ${now.toString()}`);
          assert.equal(next[0]!.dateOnly, true);
          assert.equal(next[0]!.date, plusDays(now, until === 0 ? 7 : until), `next ${WEEKDAYS[target]} @ ${now.toString()}`);
          // The plain word: today counts.
          const plain = parseDateQuery(WEEKDAYS[target]!, now);
          assert.equal(plain[0]!.date, plusDays(now, until), `${WEEKDAYS[target]} @ ${now.toString()}`);
          // The day it names really is that weekday, 1–7 days ahead.
          const [y, mo, d] = next[0]!.date.split("-").map(Number);
          assert.equal(new Date(y!, mo! - 1, d!).getDay(), target);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, STARTS.length * 7 * TIMES.length * 7);
});

test("the test's own case: on a Sunday, next monday is tomorrow; short forms and spacing", () => {
  const sunday = new Date(2026, 9, 4, 15, 0);
  assert.equal(sunday.getDay(), 0);
  for (const q of ["next monday", "Next Monday", "next mon", "  next   monday "]) assert.equal(parseDateQuery(q, sunday)[0]?.date, "2026-10-05", q);
  assert.equal(parseDateQuery("monday", new Date(2026, 9, 5, 8))[0]?.date, "2026-10-05");
  assert.equal(parseDateQuery("next monday", new Date(2026, 9, 5, 8))[0]?.date, "2026-10-12");
  // While it is being typed, no prefix of "next monday" names a different day.
  const typed = "next monday";
  for (let i = 1; i <= typed.length; i++) {
    const got = parseDateQuery(typed.slice(0, i), sunday);
    for (const c of got) assert.equal(c.date, "2026-10-05", `prefix "${typed.slice(0, i)}"`);
  }
});
