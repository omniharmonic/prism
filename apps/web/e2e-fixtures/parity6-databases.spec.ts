import { test, expect, type Page } from "@playwright/test";
import { touchTargets } from "./a11y-measure";

/**
 * Parity gaps closed with assertions (PARITY-GAPS §a.1 slice S, §a.2):
 *  - NP-AX-07  the MONTH of a database calendar on a phone: one ≥ 44 px target per day, the chosen
 *              day's pages under the grid (at 390 and at 320 px).
 *  - NP-DB-08  sorting through the UI (the Sort dialog), once per core property kind.
 */
const writes = (page: Page) => page.evaluate(() => (window as any).dbFixture.writes);
const creates = (page: Page) => page.evaluate(() => (window as any).dbFixture.creates);
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);
const ready = (page: Page) => expect(page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first()).toBeVisible();

// ── NP-AX-07: the month grid on a phone ──────────────────────────────────────

test.describe("phone month grid", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    test(`NP-AX-07: a database calendar's month is finger-sized at ${width} px — a day is one target, its pages are listed under the grid`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/e2e-fixtures/databases.html");
      await ready(page);
      const dates = await page.evaluate(() => {
        const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const now = new Date();
        const other = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 15 ? 16 : 15);
        const moved = new Date(now.getFullYear(), now.getMonth(), [15, 16, 17].includes(now.getDate()) ? 20 : 17);
        const next = new Date(now.getFullYear(), now.getMonth() + 1, 9);
        return { today: key(now), other: key(other), moved: key(moved), next: key(next), nextLabel: next.toLocaleDateString(undefined, { month: "long", year: "numeric" }), thisLabel: now.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
      });
      await page.evaluate((d) => {
        const notes = (window as any).dbFixture.notes();
        const set = (id: string, due: string | null) => { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, due }; };
        set("t1", d.today); set("t2", d.today); set("t3", d.other); set("t4", d.next); set("t5", null);
      }, dates);
      await page.getByRole("tab", { name: "Calendar", exact: true }).click();
      await page.getByRole("button", { name: "Month", exact: true }).click();
      await expect(page.getByText("Month: tap a day to see its pages.")).toBeVisible();

      const grid = page.getByRole("group", { name: "Calendar month" });
      await expect(grid).toBeVisible();
      const cells = grid.locator("button.db-month-day");
      await expect(cells).toHaveCount(42);
      // The desktop grid's small "+" and page chips are not here at all (nothing to drag on a phone).
      await expect(page.locator(".db-cal, .db-cal-add, .db-cal-item")).toHaveCount(0);
      // Every day is one target of at least 44 × 44 px; Monday first; nothing scrolls sideways.
      const sizes = await cells.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { day: el.getAttribute("data-day"), w: r.width, h: r.height, left: r.left, right: r.right }; }));
      expect(sizes.filter((s) => s.w < 44 || s.h < 44)).toEqual([]);
      expect(sizes.every((s) => s.left >= -0.5 && s.right <= width + 0.5)).toBe(true);
      expect(new Date(`${sizes[0]!.day}T12:00:00`).getDay()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The whole surface, by the same rule as the touch sweep: no small or crowded control.
      expect(await touchTargets(page)).toEqual([]);

      // Today is chosen: marked, named with its page count, and its pages are listed where a title can be read.
      const cell = (day: string) => grid.locator(`button[data-day="${day}"]`);
      await expect(cell(dates.today)).toHaveAttribute("aria-pressed", "true");
      await expect(cell(dates.today)).toHaveAttribute("aria-current", "date");
      await expect(cell(dates.today)).toHaveAccessibleName(/, 2 pages$/);
      await expect(cell(dates.today).locator(".db-month-marks > span")).toHaveCount(2);
      await expect(cell(dates.other)).toHaveAccessibleName(/, 1 page$/);
      const chosen = page.locator(".db-month-chosen");
      await expect(chosen).toHaveAttribute("data-day", dates.today);
      await expect(chosen).toContainText("Today");
      await expect(chosen.locator("[data-agenda-item]")).toHaveCount(2);
      const open = chosen.getByRole("button", { name: "Review workspace navigation", exact: true });
      expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      // Tapping another day moves the choice and lists that day's page.
      await cell(dates.other).tap();
      await expect(cell(dates.other)).toHaveAttribute("aria-pressed", "true");
      await expect(cell(dates.today)).toHaveAttribute("aria-pressed", "false");
      await expect(chosen).toHaveAttribute("data-day", dates.other);
      await expect(chosen.getByRole("button", { name: "Refine onboarding copy", exact: true })).toBeVisible();
      await expect(chosen.locator("[data-agenda-item]")).toHaveCount(1);

      // A page is moved with its date editor (the same per-field compare-and-set as a table cell).
      const item = chosen.locator('[data-agenda-item="t3"]');
      await item.getByRole("button", { name: /^Due: / }).click();
      await item.getByLabel("Due", { exact: true }).fill(dates.moved);
      await item.getByLabel("Due", { exact: true }).press("Enter");
      await expect.poll(async () => (await writes(page)).filter((w: any) => w.set).at(-1)).toMatchObject({ id: "t3", set: { due: dates.moved }, expect: { due: dates.other } });
      await expect(chosen.locator("[data-agenda-item]")).toHaveCount(0);
      await expect(chosen).toContainText("Nothing on this day");
      await expect(cell(dates.moved)).toHaveAccessibleName(/, 1 page$/);
      await expect(cell(dates.other).locator(".db-month-marks > span")).toHaveCount(0);

      // "+" adds a page ON the chosen day.
      await chosen.getByRole("button", { name: `New page on ${dates.other}` }).tap();
      await page.getByRole("textbox", { name: `New page on ${dates.other}` }).fill("Retro notes");
      await page.keyboard.press("Enter");
      await expect(chosen.getByRole("button", { name: "Retro notes", exact: true })).toBeVisible();
      expect((await creates(page)).at(-1).metadata.due).toBe(dates.other);

      // Opening a page from the list works (rows open full-page on a phone).
      await cell(dates.today).tap();
      await chosen.getByRole("button", { name: "Write release notes", exact: true }).tap();
      await expect.poll(() => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toContain("t2");
      await page.evaluate(() => { const s = (window as any).prismUI.getState(); s.setActiveTab(s.openTabs[0].id); });
      await page.getByRole("tab", { name: "Calendar", exact: true }).click();
      await page.getByRole("button", { name: "Month", exact: true }).click();

      // Month navigation: the next month holds the page dated there; Today comes back.
      await page.getByRole("button", { name: "Next month" }).tap();
      await expect(page.getByRole("heading", { name: dates.nextLabel })).toBeVisible();
      await expect(cell(dates.next)).toHaveAccessibleName(/, 1 page$/);
      await cell(dates.next).tap();
      await expect(chosen.getByRole("button", { name: "Design new icon set", exact: true })).toBeVisible();
      expect(await touchTargets(page)).toEqual([]);
      await page.getByRole("button", { name: "Today", exact: true }).tap();
      await expect(page.getByRole("heading", { name: dates.thisLabel })).toBeVisible();
      await expect(cell(dates.today)).toHaveAttribute("aria-pressed", "true");

      // The layout choice is the screen's, not the saved view's.
      expect(await configWrites(page)).toEqual([]);
      // Back to the week list with the same button.
      await page.getByRole("button", { name: "Month", exact: true }).tap();
      await expect(page.getByRole("list", { name: "Calendar week" })).toBeVisible();
      await expect(grid).toHaveCount(0);
    });
  }

  test("320 px: every view tab can be reached — the row scrolls, 'Add a view' never covers a tab", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/e2e-fixtures/databases.html");
    await ready(page);
    for (const name of ["Calendar", "List", "Gallery", "Board", "All tasks"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.scrollIntoViewIfNeeded();
      // What is under the middle of the tab is the tab.
      expect(await tab.evaluate((el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); }), name).toBe(true);
      await tab.tap();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    const add = page.getByRole("button", { name: "Add a view" });
    await add.scrollIntoViewIfNeeded();
    expect(await add.evaluate((el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

// ── NP-DB-08: sorting through the UI, once per property kind ─────────────────

/**
 * The rule (packages/core/src/lib/database/query.ts `sortRows`): rows WITH a value come first,
 * ordered by it; rows without one come last in BOTH directions. Expected orders below are written
 * out by hand from the values this test sets — not computed with the engine.
 */
type SortCase = { kind: string; key: string; label: string; /** Groups of row titles in ascending order (a group = equal values, any order inside). */ asc: string[][] };
const T = { t1: "Review workspace navigation", t2: "Write release notes", t3: "Refine onboarding copy", t4: "Design new icon set", t5: "Update pricing page", t6: "Private planning note", page: "A living workspace" };
const ALL = Object.values(T);
const SORTS: SortCase[] = [
  { kind: "text (title)", key: "$title", label: "Title", asc: [[T.page], [T.t4], [T.t6], [T.t3], [T.t1], [T.t5], [T.t2]] },
  { kind: "number", key: "estimate", label: "Estimate (h)", asc: [[T.t2], [T.t1], [T.t3], [T.t4]] }, // 2, 3, 5, 12 — numeric, not "12" < "2"
  { kind: "select", key: "priority", label: "Priority", asc: [[T.t1, T.t2], [T.t5, T.t6], [T.t3, T.t4, T.page]] }, // high, low, medium
  { kind: "status", key: "status", label: "Status", asc: [[T.t4, T.t5], [T.t2, T.t3, T.page], [T.t1, T.t6]] }, // done, in-progress, todo
  { kind: "multi-select", key: "labels", label: "Labels", asc: [[T.t1, T.t4], [T.t2]] }, // by the first label: design, launch
  { kind: "date", key: "due", label: "Due", asc: [[T.t4], [T.t5], [T.t1], [T.t2], [T.t3]] },
  { kind: "person", key: "assignee", label: "Assignee", asc: [[T.t3], [T.t1], [T.t2]] }, // Alex Stone, Mira Chen, Sam Rivera
  { kind: "relation", key: "project", label: "Project", asc: [[T.t1, T.t2], [T.t3]] }, // Atlas, Beacon
  { kind: "checkbox", key: "flagged", label: "Flagged", asc: [[T.t2], [T.t1, T.t3]] }, // unchecked (false) before checked
  { kind: "URL", key: "link", label: "Link", asc: [[T.t2], [T.t3], [T.t1]] }, // …/a, …/b, …/nav
];

test("NP-DB-08: the Sort dialog orders the table by each core property kind, both ways, with empty values last", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/e2e-fixtures/databases.html");
  await ready(page);
  // Enough distinct values per kind for an order to mean something.
  await page.evaluate(() => {
    const notes = (window as any).dbFixture.notes();
    const set = (id: string, patch: Record<string, unknown>) => { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, ...patch }; };
    set("t4", { estimate: 12 });
    set("t3", { assignee: "[[People/Alex Stone]]", project: "[[Projects/Beacon]]", flagged: true, link: "https://example.test/b" });
    set("t2", { flagged: false, link: "https://example.test/a" });
  });
  const table = page.getByRole("table", { name: "All tasks" });
  const titles = () => table.locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.querySelector("button")?.textContent?.trim() ?? "").filter(Boolean));
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  const sort = page.getByRole("dialog", { name: "Sort" });
  await sort.getByRole("button", { name: /Add sort/ }).click();
  const property = sort.getByLabel("Sort 1 property");
  const direction = sort.getByLabel("Sort 1 direction");
  // The dialog offers every kind under its label.
  const offered = await property.locator("option").evaluateAll((o) => Object.fromEntries(o.map((x) => [(x as HTMLOptionElement).value, x.textContent])));
  for (const c of SORTS) expect(offered[c.key], c.kind).toBe(c.label);

  /** Does `got` start with the groups in order (any order inside a group), followed by exactly the rows without a value? */
  const check = (got: string[], groups: string[][], what: string) => {
    const known = got.filter((t) => ALL.includes(t));
    let at = 0;
    for (const group of groups) {
      expect([...known.slice(at, at + group.length)].sort(), `${what}: rows ${at + 1}–${at + group.length}`).toEqual([...group].sort());
      at += group.length;
    }
    const withValue = groups.flat();
    expect([...known.slice(at)].sort(), `${what}: rows without a value come last`).toEqual(ALL.filter((t) => !withValue.includes(t)).sort());
  };
  for (const c of SORTS) {
    await property.selectOption(c.key);
    await direction.selectOption("asc");
    const want = c.asc.flat()[0]!;
    // The first row settles on a value of the first ascending group.
    await expect.poll(async () => c.asc[0]!.includes((await titles()).filter((t) => ALL.includes(t))[0] ?? ""), { message: `${c.kind} ascending starts with ${want}` }).toBe(true);
    await expect.poll(async () => { try { check(await titles(), c.asc, `${c.kind} ascending`); return "ok"; } catch (e) { return (e as Error).message.split("\n")[0]; } }).toBe("ok");
    check(await titles(), c.asc, `${c.kind} ascending`);
    expect((await configWrites(page)).at(-1).metadata.prism_database.views[0].sort, `${c.kind}: saved in the view`).toEqual([{ key: c.key, dir: "asc" }]);

    await direction.selectOption("desc");
    const desc = [...c.asc].reverse();
    await expect.poll(async () => { try { check(await titles(), desc, `${c.kind} descending`); return "ok"; } catch (e) { return (e as Error).message.split("\n")[0]; } }).toBe("ok");
    check(await titles(), desc, `${c.kind} descending`);
    expect((await configWrites(page)).at(-1).metadata.prism_database.views[0].sort).toEqual([{ key: c.key, dir: "desc" }]);
  }
});
