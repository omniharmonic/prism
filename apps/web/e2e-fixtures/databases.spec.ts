import { test, expect, type Page } from "@playwright/test";

const fx = (page: Page) => page.evaluate(() => { const f = (window as any).dbFixture; return { creates: f.creates, schemaWrites: f.schemaWrites }; });
const writes = (page: Page) => page.evaluate(() => (window as any).dbFixture.writes);
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });

test("table: typed cells edit in place with per-field compare-and-set, and conflicts are recoverable", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("row")).toHaveCount(1 + 7 + 1); // header, 7 rows, + New
  await expect(page.getByText("7 pages")).toBeVisible();

  // Select: pick an option from the schema enum.
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Status: in-progress" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "done" }).click();
  await expect(row(page, "Refine onboarding copy").getByRole("button", { name: "Status: done" })).toBeVisible();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { status: "done" }, expect: { status: "in-progress" } });

  // Number: typed input, committed on Enter as a number.
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Estimate (h): 5" }).click();
  await page.getByRole("textbox", { name: "Estimate (h)" }).fill("8");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { estimate: 8 }, expect: { estimate: 5 } });

  // Checkbox toggles directly.
  await row(page, "Write release notes").getByRole("checkbox", { name: "Flagged" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t2", set: { flagged: true }, expect: { flagged: null } });

  // Someone else changed the priority meanwhile: the edit is refused, nothing is lost.
  await page.evaluate(() => { (window as any).dbFixture.conflictWith = "low"; });
  await row(page, "Write release notes").getByRole("button", { name: "Priority: high" }).click();
  await page.getByRole("dialog", { name: "Choose Priority" }).getByRole("option", { name: "medium" }).click();
  const alert = row(page, "Write release notes").getByRole("alert");
  await expect(alert).toContainText("Changed elsewhere to “low”");
  await alert.getByRole("button", { name: "Keep mine" }).click();
  await expect(row(page, "Write release notes").getByRole("button", { name: "Priority: medium" })).toBeVisible();
  const last = (await writes(page)).at(-1);
  expect(last).toEqual({ id: "t2", set: { priority: "medium" }, expect: { priority: "low" } });
});

test("table: filter, header sort, hide and resize are saved to the database note", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("priority");
  await filter.getByLabel("Filter value").selectOption("high");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("row")).toHaveCount(1 + 2 + 1);
  await expect(page.getByRole("button", { name: "Filter · 1" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Due", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort descending" }).click();
  await expect(table.locator("tbody tr").first()).toContainText("Write release notes");

  await page.getByRole("button", { name: "Assignee", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide in this view" }).click();
  await expect(page.getByRole("button", { name: "Assignee", exact: true })).toHaveCount(0);

  await page.getByRole("separator", { name: "Resize Status" }).focus();
  await page.keyboard.press("ArrowRight");

  const saved = (await configWrites(page)).at(-1).metadata.prism_database.views[0];
  expect(saved.filter).toEqual({ match: "all", conditions: [{ key: "priority", op: "eq", value: "high" }] });
  expect(saved.sort).toEqual([{ key: "due", dir: "desc" }]);
  expect(saved.visible).not.toContain("assignee");
  expect(saved.widths.status).toBe(200);
  for (const w of await configWrites(page)) expect(w.ifUpdatedAt).toBeTruthy();
  // Reload: the saved view comes back.
  await page.reload();
  await expect(page.getByRole("button", { name: "Filter · 1" })).toBeVisible();
});

test("new rows are created with the tag, schema defaults and the group they were added to", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("table", { name: "All tasks" }).getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "New page title" }).fill("Ship the changelog");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Ship the changelog", exact: true })).toBeVisible();
  const created = (await fx(page)).creates.at(-1);
  expect(created).toMatchObject({ tags: ["task"], path: "Projects/Launch plan/Ship the changelog", metadata: { title: "Ship the changelog", status: "todo" } });

  await page.getByRole("tab", { name: "Board" }).click();
  const done = page.getByRole("region", { name: "done", exact: true });
  await done.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("textbox", { name: "New page in done" }).fill("Archive old docs");
  await page.keyboard.press("Enter");
  await expect(done.getByRole("article", { name: "Archive old docs" })).toBeVisible();
  expect((await fx(page)).creates.at(-1).metadata).toMatchObject({ status: "done", title: "Archive old docs" });

  // A failed create keeps the typed title.
  await page.evaluate(() => { (window as any).dbFixture.failNext = true; });
  await done.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("textbox", { name: "New page in done" }).fill("Retry me");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "could not be created" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "New page in done" })).toHaveValue("Retry me");
});

test("board: move by menu and by drag writes the group property, rank stays view-local", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Board" }).click();
  const todo = page.getByRole("region", { name: "todo", exact: true });
  const inProgress = page.getByRole("region", { name: "in-progress", exact: true });
  const done = page.getByRole("region", { name: "done", exact: true });
  await expect(todo.getByRole("article")).toHaveCount(2);

  await page.getByRole("button", { name: "Actions for Review workspace navigation" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "done" }).click();
  await expect(done.getByRole("article", { name: "Review workspace navigation" })).toBeVisible();
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { status: "done" }, expect: { status: "todo" } });

  const card = inProgress.getByRole("article", { name: "Write release notes" });
  const box = (await card.boundingBox())!;
  const target = (await todo.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 20, { steps: 12 });
  await page.mouse.up();
  await expect(todo.getByRole("article", { name: "Write release notes" })).toBeVisible();
  expect((await writes(page)).at(-1)).toEqual({ id: "t2", set: { status: "todo" }, expect: { status: "in-progress" } });
  // The task note itself never carries a rank.
  expect((await writes(page)).every((w: any) => !w.set || !("order" in w.set))).toBe(true);
});

test("gallery, list and calendar render the same rows; calendar adds on a day", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Gallery" }).click();
  await expect(page.getByRole("list", { name: "Gallery gallery" }).getByRole("listitem")).toHaveCount(7);
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.getByRole("list", { name: "List list" }).getByRole("button", { name: "Update pricing page" })).toBeVisible();
  await page.getByRole("tab", { name: "Calendar" }).click();
  const cal = page.getByRole("grid", { name: "Calendar calendar" });
  await expect(cal.getByRole("button", { name: "Review workspace navigation" })).toBeVisible();
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await cal.getByRole("button", { name: `New page on ${today}` }).click();
  await page.getByRole("textbox", { name: `New page on ${today}` }).fill("Standup notes");
  await page.keyboard.press("Enter");
  await expect(cal.getByRole("button", { name: "Standup notes" })).toBeVisible();
  expect((await fx(page)).creates.at(-1).metadata.due).toBe(today);
  await cal.getByRole("button", { name: "Standup notes" }).click();
  expect(await page.evaluate(() => (window as any).prismUI.getState().openTabs.some((t: any) => t.title === "Standup notes"))).toBe(true);
});

test("adding a view and opening a row", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "Add a view" }).click();
  await page.getByRole("menuitem", { name: "Board" }).click();
  await expect(page.getByRole("tab", { name: "Board" })).toHaveCount(2);
  const views = (await configWrites(page)).at(-1).metadata.prism_database.views;
  expect(views.at(-1)).toMatchObject({ type: "board", groupBy: "status" });
  await page.getByRole("tab", { name: "All tasks" }).click();
  await page.getByRole("button", { name: "Design new icon set", exact: true }).click();
  expect(await page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toContain("t4");
});

test("viewer: read-only cells, hidden private rows, honest 'limited' and session-only view changes", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await expect(page.getByText("6 pages · only pages you can see")).toBeVisible();
  await expect(page.getByRole("button", { name: "Private planning note" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a view" })).toHaveCount(0);
  await row(page, "Write release notes").getByRole("button", { name: "Status: in-progress" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Status" })).toHaveCount(0);
  await page.getByRole("button", { name: "Due", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect(page.getByRole("status").filter({ hasText: "view changes stay in this tab" })).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  expect((await writes(page)).length).toBe(0);
});

test("legacy shell: bundled schemas + listNotes fallback, metadata-only CAS writes", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?legacy");
  await expect(page.getByRole("table", { name: "All tasks" }).getByRole("row")).toHaveCount(1 + 7 + 1);
  await row(page, "Update pricing page").getByRole("button", { name: "Status: done" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "todo" }).click();
  await expect(row(page, "Update pricing page").getByRole("button", { name: "Status: todo" })).toBeVisible();
  const w = (await writes(page)).at(-1);
  expect(w).toEqual({ id: "t5", metadata: { status: "todo" }, ifUpdatedAt: "2026-10-01T12:00:00.000Z" });
});

test("phone: sticky first column, no page overflow, filters in a sheet", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html");
  const first = page.getByRole("button", { name: "Review workspace navigation", exact: true });
  await expect(first).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const wrap = page.locator(".db-table-wrap").first();
  const before = (await first.boundingBox())!.x;
  await wrap.evaluate((el) => { el.scrollLeft = 400; });
  await expect.poll(async () => (await first.boundingBox())!.x).toBe(before);
  await page.screenshot({ path: info.outputPath("db-table-390.png") });
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Filter" });
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.width).toBeGreaterThan(370);
  await page.screenshot({ path: info.outputPath("db-filter-sheet-390.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Board" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("db-board-390.png") });
});
