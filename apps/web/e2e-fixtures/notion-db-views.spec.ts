import { test, expect, type Page } from "@playwright/test";

/** Notion parity — database views (NP-DB-15, 17, 18, 19, 21). Fixture: databases.html. */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const writes = async (page: Page) => (await fx(page)).writes as any[];
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);
const table = (page: Page, name = "All tasks") => page.getByRole("table", { name });
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });
const openTabs = (page: Page) => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId));

test("table group by with counts", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByLabel("Group by").selectOption("status");
  await page.keyboard.press("Escape");
  const todo = page.getByRole("region", { name: "To do", exact: true });
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(todo.getByLabel("2 pages")).toBeVisible();
  await expect(page.getByRole("region", { name: "In progress" }).getByLabel("3 pages")).toBeVisible();
  await expect(done.getByRole("table").getByRole("button", { name: "Design new icon set", exact: true })).toBeVisible();
  expect((await configWrites(page)).at(-1).metadata.prism_database.views[0].groupBy).toBe("status");

  // Collapse a group: its rows leave, its count stays.
  await done.getByRole("button", { name: "Collapse Done" }).click();
  await expect(done.getByRole("table")).toHaveCount(0);
  await expect(done.getByLabel("2 pages")).toBeVisible();
  await done.getByRole("button", { name: "Expand Done" }).click();

  // "+ New" inside a group creates the row IN that group.
  await done.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "New page title" }).fill("Archive old builds");
  await page.keyboard.press("Enter");
  await expect(done.getByLabel("3 pages")).toBeVisible();
  expect((await fx(page)).creates.at(-1)).toMatchObject({ path: "Projects/Launch plan/Archive old builds", metadata: { status: "done" } });

  // List views group the same way.
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByLabel("Group by").selectOption("priority");
  await page.keyboard.press("Escape");
  const high = page.getByRole("region", { name: "High", exact: true });
  await expect(high.getByLabel("2 pages")).toBeVisible();
  await expect(high.getByRole("list", { name: "High list" }).getByRole("button", { name: "Write release notes" })).toBeVisible();
});

test("database search box", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const search = page.getByRole("searchbox", { name: "Search this database" });
  // A text property (the assignee link) matches, not only the title.
  await search.fill("mira");
  await expect(table(page).locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(row(page, "Review workspace navigation")).toBeVisible();
  expect((await fx(page)).queries.at(-1).search).toBe("mira");
  // Titles match live too; an empty result says so and offers a way out.
  await search.fill("pricing");
  await expect(table(page).locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(row(page, "Update pricing page")).toBeVisible();
  await search.fill("zzzz");
  await expect(page.getByRole("heading", { name: "No pages match this view" })).toBeVisible();
  // Escape clears the box and every row comes back.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByRole("rowheader", { name: "Count: 7" })).toBeVisible();
});

test("side peek, center peek, full page", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const scroller = page.locator(".db-scroll");
  await scroller.evaluate((el) => { el.scrollTop = 120; });
  const before = await scroller.evaluate((el) => el.scrollTop);

  // Default: side peek. The row's page (title, properties, body) edits in place.
  await page.getByRole("button", { name: "Refine onboarding copy", exact: true }).click();
  const side = page.getByRole("dialog", { name: "Refine onboarding copy (side peek)" });
  await expect(side).toBeVisible();
  await expect(side.getByText("Refine onboarding copy — fictional task.")).toBeVisible();
  await side.getByRole("button", { name: "Status: In progress" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "Done" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { status: "done" }, expect: { status: "in-progress" } });
  expect(await openTabs(page)).toEqual(["db"]);

  // Esc closes the peek and keeps the database where it was.
  await page.keyboard.press("Escape");
  await expect(side).toHaveCount(0);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

  // Center peek, saved as the database's preference.
  await page.getByRole("button", { name: "Write release notes", exact: true }).click();
  await page.getByRole("dialog", { name: /side peek/ }).getByRole("button", { name: "Center peek" }).click();
  await expect(page.getByRole("dialog", { name: "Write release notes (center peek)" })).toBeVisible();
  expect((await configWrites(page)).at(-1).metadata.prism_database.openIn).toBe("center");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Update pricing page", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Update pricing page (center peek)" })).toBeVisible();

  // Full page: opens the row as a page and becomes the preference.
  await page.getByRole("dialog", { name: /center peek/ }).getByRole("button", { name: "Full page" }).click();
  await expect.poll(() => openTabs(page)).toContain("t5");
  expect((await configWrites(page)).at(-1).metadata.prism_database.openIn).toBe("page");

  // ⌘/Ctrl-click always opens the page.
  await page.goto("/e2e-fixtures/databases.html");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Design new icon set", exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => openTabs(page)).toContain("t4");
  await expect(page.getByRole("dialog", { name: /peek/ })).toHaveCount(0);
});

test("side peek: phones always open the full page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "Refine onboarding copy", exact: true }).click();
  await expect.poll(() => openTabs(page)).toContain("t3");
  await expect(page.getByRole("dialog", { name: /peek/ })).toHaveCount(0);
});

test("database template applies on new row", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?templates");
  // An existing template: body + properties land on the new row.
  await page.getByRole("button", { name: "New page from a template" }).click();
  await page.getByRole("menuitem", { name: "Bug report" }).click();
  await expect.poll(async () => (await fx(page)).creates.length).toBe(1);
  const fromBug = (await fx(page)).creates[0];
  expect(fromBug.content).toContain("Steps to reproduce");
  expect(fromBug.tags).toEqual(["task"]);
  expect(fromBug.metadata).toMatchObject({ status: "todo", priority: "high", labels: ["bug"] });
  expect(fromBug.path).toBe("Projects/Launch plan/Untitled"); // NP-DB-20: the name is the path, no stored copy
  await expect(page.getByRole("dialog", { name: "Untitled (side peek)" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Make a new template, give it a starting property, make it the default.
  await page.getByRole("button", { name: "New page from a template" }).click();
  await page.getByRole("button", { name: "New template" }).click();
  await page.getByRole("textbox", { name: "Template name" }).fill("Release checklist");
  await page.getByRole("button", { name: "Create template" }).click();
  const editor = page.getByRole("dialog", { name: "Template: Release checklist" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Priority: Empty" }).click();
  await page.getByRole("dialog", { name: "Choose Priority" }).getByRole("option", { name: "Low" }).click();
  await expect(editor.getByRole("button", { name: "Priority: Low" })).toBeVisible();
  await editor.getByRole("button", { name: "Done" }).click();
  const saved = (await configWrites(page)).at(-1).metadata.prism_database.templates;
  expect(saved.map((t: any) => t.name)).toEqual(["Bug report", "Sneaky", "Release checklist"]);
  // The template note is not a row: it does not carry the source tag.
  const tplNote = (await fx(page)).creates.at(-1);
  expect(tplNote.tags).toEqual([]);
  expect(tplNote.path).toMatch(/^Projects\/Launch plan\/Templates\/Release checklist/);

  await page.getByRole("button", { name: "New page from a template" }).click();
  await page.getByRole("button", { name: "Make Release checklist the default" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await configWrites(page)).at(-1).metadata.prism_database.defaultTemplate).toBeTruthy();
  const n = (await fx(page)).creates.length;
  await page.locator(".db-actions").getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(async () => (await fx(page)).creates.length).toBe(n + 1);
  expect((await fx(page)).creates.at(-1)).toMatchObject({ path: "Projects/Launch plan/Untitled", metadata: { priority: "low" } });
});

test("bulk edit and bulk trash with undo", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const t = table(page);
  // Checkbox, then shift-click extends the range (table order: last edited first).
  await t.getByRole("checkbox", { name: "Select Refine onboarding copy" }).click();
  await t.getByRole("checkbox", { name: "Select Update pricing page" }).click({ modifiers: ["Shift"] });
  const bar = page.getByRole("toolbar", { name: "Selected pages" });
  await expect(bar.getByText("3 selected")).toBeVisible();

  // Bulk edit = one batch; a row changed elsewhere is reported, the rest written.
  await page.evaluate(() => { (window as any).dbFixture.conflictWith = "high"; });
  await bar.getByRole("button", { name: "Edit property" }).click();
  const edit = page.getByRole("dialog", { name: "Edit property on selected pages" });
  await edit.getByLabel("Property to edit").selectOption("priority");
  await edit.getByRole("button", { name: "Priority: Empty" }).click();
  await page.getByRole("dialog", { name: "Choose Priority" }).getByRole("option", { name: "Low" }).click();
  const toast = page.locator(".db-toast");
  await expect(toast).toContainText("Updated Priority on 2 of 3. Not changed: Refine onboarding copy (changed elsewhere).");
  const batch = (await fx(page)).batches.at(-1);
  expect(batch).toEqual([
    { id: "t3", set: { priority: "low" }, expect: { priority: "medium" } },
    { id: "t4", set: { priority: "low" }, expect: { priority: "medium" } },
    { id: "t5", set: { priority: "low" }, expect: { priority: "low" } },
  ]);
  await expect(row(page, "Design new icon set").getByRole("button", { name: "Priority: Low" })).toBeVisible();
  // One Undo puts back what each written row had (CAS on the new value).
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("Restored Priority on 2 pages.");
  expect((await fx(page)).batches.at(-1)).toEqual([
    { id: "t4", set: { priority: "medium" }, expect: { priority: "low" } },
    { id: "t5", set: { priority: "low" }, expect: { priority: "low" } },
  ]);
  await expect(row(page, "Design new icon set").getByRole("button", { name: "Priority: Medium" })).toBeVisible();

  // ⌘A selects every row; Escape clears.
  await t.getByRole("button", { name: "Write release notes", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(bar.getByText("7 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);

  // Bulk move to Trash (pages API), then one Undo restores them.
  await t.getByRole("checkbox", { name: "Select Design new icon set" }).click();
  await t.getByRole("checkbox", { name: "Select Update pricing page" }).click();
  await page.getByRole("toolbar", { name: "Selected pages" }).getByRole("button", { name: "Move to Trash" }).click();
  await expect(toast).toContainText("Moved 2 pages to Trash.");
  await expect(page.getByRole("rowheader", { name: "Count: 5" })).toBeVisible();
  expect([...(await fx(page)).trashed].sort()).toEqual(["t4", "t5"]);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("Restored 2 pages.");
  await expect(page.getByRole("rowheader", { name: "Count: 7" })).toBeVisible();
  expect([...(await fx(page)).restored].sort()).toEqual(["t4", "t5"]);
});

test("bulk: viewers get no selection and no bulk actions", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await expect(row(page, "Write release notes")).toBeVisible();
  await expect(table(page).getByRole("checkbox", { name: /^Select / })).toHaveCount(0);
  await table(page).getByRole("button", { name: "Write release notes", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByRole("toolbar", { name: "Selected pages" })).toHaveCount(0);
});

test("templates: an entry that is not a template of this database copies nothing", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?templates");
  await page.getByRole("button", { name: "New page from a template" }).click();
  await page.getByRole("menuitem", { name: "Sneaky" }).click();
  await expect(page.locator(".db-toast")).toContainText("That template is not part of this database, so nothing was copied from it.");
  expect((await fx(page)).creates).toEqual([]);
});

test("bulk duplicate keeps a private page private", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await table(page).getByRole("checkbox", { name: "Select Private planning note" }).click();
  await table(page).getByRole("checkbox", { name: "Select Update pricing page" }).click();
  await page.getByRole("toolbar", { name: "Selected pages" }).getByRole("button", { name: "Duplicate" }).click();
  await expect(page.locator(".db-toast")).toContainText("Duplicated 2 pages.");
  const creates = (await fx(page)).creates as any[];
  const priv = creates.find((c) => c.metadata.title === "Private planning note (copy)");
  const pub = creates.find((c) => c.metadata.title === "Update pricing page (copy)");
  expect(priv.metadata.prism_visibility).toBe("private");
  expect(pub.metadata.prism_visibility).toBeUndefined();
});

// NP-PG-18 (re-review S1): the bulk bar goes through the server's Duplicate route where the
// client has one, waits out a rate limit, and re-sends the SAME request.
test("bulk duplicate uses the Duplicate route per row, waits out a 429 with the same requestId, and Undo trashes the copies", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?dup-route");
  await table(page).getByRole("checkbox", { name: "Select Private planning note" }).click();
  await table(page).getByRole("checkbox", { name: "Select Update pricing page" }).click();
  const bar = page.getByRole("toolbar", { name: "Selected pages" });
  await bar.getByRole("button", { name: "Duplicate" }).click();
  // The second row is refused once (Retry-After 1 s): the bar says it is waiting — it does not fail the row.
  await expect(bar).toContainText("Duplicating 2 of 2… — waiting for the server");
  await expect(page.locator(".db-toast")).toContainText("Duplicated 2 pages.");
  await expect(page.locator(".db-toast")).toContainText("1 copy is private to you.");
  const state = await fx(page);
  const calls = state.duplicates as Array<{ id: string; requestId: string; confirmShared: boolean }>;
  expect(calls).toHaveLength(3);
  expect(calls[1]!.id).toBe(calls[2]!.id);
  expect(calls[1]!.requestId).toBe(calls[2]!.requestId);
  expect(calls[0]!.requestId).not.toBe(calls[1]!.requestId);
  expect(state.creates).toHaveLength(0); // nothing was copied on the device
  await page.locator(".db-toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".db-toast")).toContainText("Moved 2 copies to Trash.");
  expect(((await fx(page)).trashed as string[]).sort()).toEqual(["dup-1", "dup-3"]);
});

test("bulk duplicate can be stopped while it waits for the server: what was copied stays, the rest is reported as not copied", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?dup-route=slow");
  await table(page).getByRole("checkbox", { name: "Select Private planning note" }).click();
  await table(page).getByRole("checkbox", { name: "Select Update pricing page" }).click();
  const bar = page.getByRole("toolbar", { name: "Selected pages" });
  await bar.getByRole("button", { name: "Duplicate" }).click();
  await expect(bar).toContainText("waiting for the server (60 s)");
  await bar.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".db-toast")).toContainText("Duplicated 1 of 2.");
  await expect(page.locator(".db-toast")).toContainText("Stopped — 1 page was not copied.");
  const state = await fx(page);
  expect(state.duplicates).toHaveLength(2); // the refused request was not sent again
  expect(state.creates).toHaveLength(0);
});
