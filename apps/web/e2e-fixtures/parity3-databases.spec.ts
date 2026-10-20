import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 3 (slice G) — database clauses with no assertion until now:
 *   NP-DB-07  the calendar on ANOTHER date property (view `dateKey`)
 *   NP-DB-08  the multi-select and URL editors
 *   NP-DB-20  editing a row's body; renaming the row updates the view
 */
const writes = (page: Page) => page.evaluate(() => (window as any).dbFixture.writes as any[]);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** NP-DB-07 · "Calendar view on any date property." */
test("NP-DB-07: the calendar can show another date property, and that choice is saved on the view", async ({ page }) => {
  // Midday, mid-month: every date below is in the month on screen.
  await page.clock.setFixedTime(new Date(2026, 9, 14, 12, 0));
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("table", { name: "All tasks" })).toBeVisible();
  // A second date property ("Review") on the same pages, with other days than "Due".
  await page.evaluate(() => {
    const f = (window as any).dbFixture;
    const schemas = f.schemas();
    schemas.task.fields.review = { type: "string", kind: "date", label: "Review" };
    sessionStorage.setItem("db-fixture-schemas", JSON.stringify(schemas));
    const notes = f.notes();
    const set = (id: string, meta: Record<string, unknown>) => { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, ...meta }; };
    set("t1", { due: "2026-10-16", review: "2026-10-22" });
    set("t2", { due: "2026-10-18", review: "2026-10-27" });
    set("t3", { due: "2026-10-22" }); // no review date
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Calendar" }).click();
  const cal = page.getByRole("grid", { name: "Calendar calendar" });
  const dayOf = (title: string) => cal.locator("[data-day]", { has: page.getByRole("button", { name: title, exact: true }) }).first().getAttribute("data-day");
  // By "Due" (the view's saved property).
  expect(await dayOf("Review workspace navigation")).toBe("2026-10-16");
  expect(await dayOf("Write release notes")).toBe("2026-10-18");
  expect(await dayOf("Refine onboarding copy")).toBe("2026-10-22");
  // Choose the other property.
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  const picker = settings.getByRole("combobox", { name: "Date property" });
  await expect(picker).toHaveValue("due");
  await expect(picker.locator("option")).toContainText(["Due", "Review", "Created"]);
  await picker.selectOption("review");
  await page.keyboard.press("Escape");
  // The same pages now sit on their Review days; a page with no Review date is not on the grid.
  await expect.poll(() => dayOf("Review workspace navigation")).toBe("2026-10-22");
  expect(await dayOf("Write release notes")).toBe("2026-10-27");
  await expect(cal.getByRole("button", { name: "Refine onboarding copy", exact: true })).toHaveCount(0);
  // Saved on the view (the database page's config), nothing on the rows.
  const config = (await writes(page)).filter((w) => w.metadata?.prism_database).at(-1);
  expect(config.id).toBe("db");
  expect(config.metadata.prism_database.views.find((v: any) => v.id === "calendar")).toMatchObject({ type: "calendar", dateKey: "review" });
  expect((await writes(page)).filter((w) => w.set)).toEqual([]);
  // A page added on a day gets THAT property.
  await cal.getByRole("button", { name: "New page on 2026-10-29" }).click();
  await page.getByRole("textbox", { name: "New page on 2026-10-29" }).fill("Retro");
  await page.keyboard.press("Enter");
  await expect(cal.getByRole("button", { name: "Retro", exact: true })).toBeVisible();
  const created = await page.evaluate(() => (window as any).dbFixture.creates.at(-1).metadata);
  expect(created.review).toBe("2026-10-29");
  expect(created.due).toBeUndefined();
  // It survives a reload.
  await page.reload();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect.poll(() => dayOf("Write release notes")).toBe("2026-10-27");
});

/** NP-DB-07: the built-in "Created" date is a choice too. */
test("NP-DB-07: the calendar by Created date", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 8, 28, 12, 0));
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByRole("combobox", { name: "Date property" }).selectOption("$createdAt");
  await page.keyboard.press("Escape");
  const cal = page.getByRole("grid", { name: "Calendar calendar" });
  const dayOf = (title: string) => cal.locator("[data-day]", { has: page.getByRole("button", { name: title, exact: true }) }).first().getAttribute("data-day");
  // Created 2026-09-20 and 2026-09-25 (local days of the fixture's timestamps).
  await expect.poll(() => dayOf("Review workspace navigation")).toBe(ymd(new Date("2026-09-20T09:00:00.000Z")));
  expect(await dayOf("Write release notes")).toBe(ymd(new Date("2026-09-25T09:00:00.000Z")));
});

/** NP-DB-08 · "Core property types work as editors … multi-select …". */
test("NP-DB-08: the multi-select editor adds, creates and removes options", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const cell = row(page, "Review workspace navigation");
  await cell.getByRole("button", { name: "Labels: design" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Labels" });
  const list = picker.getByRole("listbox", { name: "Labels" });
  await expect(list).toHaveAttribute("aria-multiselectable", "true");
  await expect(list.getByRole("option", { name: "design" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("option", { name: "launch" })).toHaveAttribute("aria-selected", "false");
  // Pick a second option: the picker stays open (several can be chosen).
  await list.getByRole("option", { name: "launch" }).click();
  await expect(picker).toBeVisible();
  await expect(list.getByRole("option", { name: "launch" })).toHaveAttribute("aria-selected", "true");
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { labels: ["design", "launch"] }, expect: { labels: ["design"] } });
  // Create a new option by typing it.
  await picker.getByRole("textbox", { name: "Search Labels options" }).fill("urgent");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { labels: ["design", "launch", "urgent"] }, expect: { labels: ["design", "launch"] } });
  // Remove one by choosing it again.
  await list.getByRole("option", { name: "design" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { labels: ["launch", "urgent"] }, expect: { labels: ["design", "launch", "urgent"] } });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  // The cell shows both chips; the stored value is an array.
  await expect(cell.getByRole("button", { name: "Labels: launch, urgent" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t1").metadata.labels)).toEqual(["launch", "urgent"]);
  // An empty cell can be filled, and Clear empties it again.
  const empty = row(page, "Update pricing page");
  await empty.getByRole("button", { name: "Labels: Empty" }).click();
  await page.getByRole("dialog", { name: "Choose Labels" }).getByRole("option", { name: "design" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t5", set: { labels: ["design"] }, expect: { labels: null } });
  await page.getByRole("dialog", { name: "Choose Labels" }).getByRole("button", { name: "Clear" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t5", set: { labels: null }, expect: { labels: ["design"] } });
  await expect(empty.getByRole("button", { name: "Labels: Empty" })).toBeVisible();
});

/** NP-DB-08 · "… and URL." */
test("NP-DB-08: the URL editor stores a link and the cell opens it", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const cell = row(page, "Review workspace navigation");
  // A stored URL is shown with a real link beside the editor button.
  const link = cell.getByRole("link", { name: "example.test/nav" });
  await expect(link).toHaveAttribute("href", "https://example.test/nav");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  // Edit it.
  await cell.getByRole("button", { name: "Link: https://example.test/nav" }).click();
  const input = page.getByRole("textbox", { name: "Link", exact: true });
  await expect(input).toHaveAttribute("type", "url");
  await expect(input).toHaveValue("https://example.test/nav");
  await input.fill("https://example.test/handbook");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { link: "https://example.test/handbook" }, expect: { link: "https://example.test/nav" } });
  await expect(cell.getByRole("link", { name: "example.test/handbook" })).toHaveAttribute("href", "https://example.test/handbook");
  // Escape leaves the value alone.
  await cell.getByRole("button", { name: "Link: https://example.test/handbook" }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("https://example.test/discarded");
  await page.keyboard.press("Escape");
  await expect(cell.getByRole("button", { name: "Link: https://example.test/handbook" })).toBeVisible();
  // A row with no link gets one; emptying it clears the value.
  const empty = row(page, "Update pricing page");
  await empty.getByRole("button", { name: "Link: Empty" }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("https://example.test/pricing");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t5", set: { link: "https://example.test/pricing" }, expect: { link: null } });
  await empty.getByRole("button", { name: "Link: https://example.test/pricing" }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t5", set: { link: null }, expect: { link: "https://example.test/pricing" } });
  await expect(empty.getByRole("link")).toHaveCount(0);
  // Something that is not a web address is refused beside the cell: never stored, never a link.
  const before = (await writes(page)).length;
  await empty.getByRole("button", { name: "Link: Empty" }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("javascript:alert(1)");
  await page.keyboard.press("Enter");
  await expect(empty.getByRole("alert")).toContainText("That isn’t a web address");
  expect((await writes(page)).length).toBe(before);
  await expect(empty.getByRole("link")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(empty.getByRole("button", { name: "Link: Empty" })).toBeVisible();
});

/** NP-DB-20 · "Every row opens as a normal page with … the body editable." */
test("NP-DB-20: a row's body is edited in the peek and as a page, and saved to that page", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "Design new icon set", exact: true }).click();
  const peek = page.getByRole("dialog", { name: /Design new icon set \(side peek\)/ });
  const body = peek.locator(".tiptap[contenteditable=true]");
  await expect(body).toContainText("Design new icon set — fictional task.");
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Edited in the peek.");
  const contentWrite = async () => (await writes(page)).filter((w) => w.id === "t4" && typeof w.content === "string").at(-1);
  await expect.poll(async () => (await contentWrite())?.content ?? "", { timeout: 10_000 }).toContain("Edited in the peek.");
  // The save is the body only, on the row's own page, against its revision; properties untouched.
  const first = (await contentWrite())!;
  expect(first.metadata).toBeUndefined();
  expect(typeof first.ifUpdatedAt).toBe("string");
  // As a normal page: same body, with the row's properties under the title.
  await peek.getByRole("button", { name: "Open as page" }).click();
  const doc = page.locator(".tiptap[contenteditable=true]").last();
  await expect(doc).toContainText("Edited in the peek.");
  await expect(page.getByRole("button", { name: "Status: done" }).last()).toBeVisible();
  await doc.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Edited as a page.");
  await expect.poll(async () => (await contentWrite())?.content ?? "", { timeout: 10_000 }).toContain("Edited as a page.");
  const stored = await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t4"));
  expect(stored.content).toContain("Edited in the peek.");
  expect(stored.content).toContain("Edited as a page.");
  expect(stored.metadata).toMatchObject({ status: "done", priority: "medium", title: "Design new icon set" });
});

async function renameRowFromPeek(page: Page, from: string, to: string) {
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: from, exact: true })).toBeVisible();
  await table.getByRole("button", { name: from, exact: true }).click();
  const peek = page.getByRole("dialog", { name: new RegExp(`${from} \\(side peek\\)`) });
  await peek.getByRole("button", { name: `Rename ${from}`, exact: true }).click();
  const title = peek.getByRole("textbox", { name: "Document title" });
  await title.fill(to);
  await title.press("Enter");
  return table;
}

/** NP-DB-20 · "Renaming the row updates the view." — a row that is named by its page (no stored title property). */
test("NP-DB-20: renaming a row from its page title updates the row in the view", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("table", { name: "All tasks" })).toBeVisible();
  // An ordinary page carrying the database's tag: its name is its file name.
  await page.evaluate(() => {
    const notes = (window as any).dbFixture.notes();
    const n = notes.find((x: any) => x.id === "t5");
    const { title: _title, ...rest } = n.metadata;
    n.metadata = rest;
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  });
  await page.reload();
  const table = await renameRowFromPeek(page, "Update pricing page", "Publish the new pricing");
  // The page was renamed (its path moved) …
  await expect.poll(() => page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t5").path)).toBe("Projects/Launch plan/Publish the new pricing");
  // … and the view behind shows the new name, not the old one. Its properties did not change.
  await expect(table.getByRole("button", { name: "Publish the new pricing", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Update pricing page", exact: true })).toHaveCount(0);
  await expect(page.locator("tr", { has: page.getByRole("button", { name: "Publish the new pricing", exact: true }) }).getByRole("button", { name: "Status: done" })).toBeVisible();
  // The row count is unchanged (a rename, not a copy).
  await expect(table.getByRole("row")).toHaveCount(1 + 7 + 1 + 1);
});

/**
 * NP-DB-20 · the same for a row CREATED IN the database view.
 * Was a behaviour gap (PARITY-GAPS a.1 — seen failing 2026-10-03): a row made with "+ New" (and every
 * ingest row) stores its name in `metadata.title`, which the view shows first (`noteTitle`); renaming
 * the page from its title moves the path (`renamePageFromTitle`) and leaves `metadata.title` alone,
 * so the view keeps the old name.
 */
test("NP-DB-20: renaming a row that was created in the view updates the row in the view", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = await renameRowFromPeek(page, "Update pricing page", "Publish the new pricing");
  await expect.poll(() => page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t5").path)).toBe("Projects/Launch plan/Publish the new pricing");
  await expect(table.getByRole("button", { name: "Publish the new pricing", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Update pricing page", exact: true })).toHaveCount(0);
});
