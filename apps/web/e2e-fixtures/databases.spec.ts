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
  // The property write; the view's rank is saved separately on the database note.
  expect((await writes(page)).filter((w: any) => w.set).at(-1)).toEqual({ id: "t2", set: { status: "todo" }, expect: { status: "in-progress" } });
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
  // Rows open in the side peek by default (NP-DB-18); ⌘/Ctrl-click opens the page.
  await cal.getByRole("button", { name: "Standup notes" }).click({ modifiers: ["ControlOrMeta"] });
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
  // The side peek first; "Open as page" opens the row as a normal page.
  const peek = page.getByRole("dialog", { name: /Design new icon set \(side peek\)/ });
  await expect(peek).toBeVisible();
  await peek.getByRole("button", { name: "Open as page" }).click();
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

test("L3: quick consecutive view changes chain on the saved revision (no false conflict)", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.evaluate(() => { (window as any).dbFixture.slowMs = 400; });
  await page.getByRole("button", { name: "Due", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await page.getByRole("button", { name: "Assignee", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide in this view" }).click();
  const saved = () => page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "db").metadata.prism_database.views[0]);
  await expect.poll(async () => (await saved()).visible.includes("assignee")).toBe(false);
  expect((await saved()).sort).toEqual([{ key: "due", dir: "asc" }]);
  const cw = await configWrites(page);
  expect(cw).toHaveLength(2);
  expect(cw[1].ifUpdatedAt).not.toBe(cw[0].ifUpdatedAt); // the second save used the first save's revision
  await expect(page.getByRole("alert").filter({ hasText: "changed somewhere else" })).toHaveCount(0);
});

test("L5: a capability link (no _caps) gets no edit affordances it cannot use", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?link");
  await expect(page.getByRole("button", { name: "Review workspace navigation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a view" })).toHaveCount(0);
  await row(page, "Write release notes").getByRole("button", { name: "Status: in-progress" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Status" })).toHaveCount(0);
  expect((await writes(page)).length).toBe(0);
});

test("L4: a 403 from the query route is an error, never a fallback listing", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?forbidden");
  await expect(page.getByRole("alert").filter({ hasText: "Pages could not be loaded" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).dbFixture.listCalls)).toBe(0);
});

test("L8: the search box is debounced", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByText("7 pages")).toBeVisible();
  await page.getByLabel("Search this database").pressSequentially("release", { delay: 40 });
  await expect(page.getByText("1 page", { exact: true })).toBeVisible();
  const searches = await page.evaluate(() => (window as any).dbFixture.queries.filter((q: any) => q.search).map((q: any) => q.search));
  expect(searches).toEqual(["release"]);
});

test.describe("L2: dates in the viewer's timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  test("a UTC datetime lands on its local calendar day; queries carry the tz offset", async ({ page }) => {
    await page.goto("/e2e-fixtures/databases.html?tz");
    await page.getByRole("tab", { name: "Calendar" }).click();
    const { local } = await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() + 2);
      return { local: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
    });
    const label = await page.evaluate((iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), local);
    await expect(page.getByRole("gridcell", { name: label }).getByRole("button", { name: "Late call" })).toBeVisible();
    const q = await page.evaluate(() => (window as any).dbFixture.queries.at(-1));
    expect(q.tzOffset).toBe(await page.evaluate(() => new Date().getTimezoneOffset()));
  });
});

test("AND/OR filter groups", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  // A simple condition: priority is high…
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("priority");
  await filter.getByLabel("Filter value").first().selectOption("high");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(2);
  // …AND a group: (status is todo OR status is done).
  await filter.getByRole("button", { name: "New filter group" }).click();
  const group = filter.getByRole("group", { name: "Filter group 1" });
  await group.getByLabel("Group 1 condition 1 property").selectOption("status");
  await group.getByLabel("Filter value").selectOption("todo");
  await group.getByRole("button", { name: "Add condition to group 1" }).click();
  await group.getByLabel("Group 1 condition 2 property").selectOption("status");
  await group.getByLabel("Filter value").nth(1).selectOption("done");
  await expect(group.getByLabel("Group 1 match")).toHaveValue("any");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(table.getByRole("button", { name: "Review workspace navigation", exact: true })).toBeVisible();
  // The top level can be OR too: high OR (todo OR done).
  await filter.getByLabel("Match", { exact: true }).selectOption("any");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(5);
  const saved = (await configWrites(page)).at(-1).metadata.prism_database.views[0].filter;
  expect(saved).toEqual({
    match: "any",
    conditions: [{ key: "priority", op: "eq", value: "high" }],
    groups: [{ match: "any", conditions: [{ key: "status", op: "eq", value: "todo" }, { key: "status", op: "eq", value: "done" }] }],
  });
  await expect(page.getByRole("button", { name: "Filter · 3" })).toBeVisible();
  // The server engine evaluated the same grammar (the fixture runs it on every query).
  expect((await page.evaluate(() => (window as any).dbFixture.queries.at(-1).filter))).toEqual(saved);
});

test("gallery card size and cover", async ({ page }) => {
  // Covers (wave 2B, NP-DB-05): the page cover image (with its focal point), a brand gradient, else the icon/initial.
  await page.route("**/api/attachments/*", (r) => r.fulfill({ path: "e2e-fixtures/media/cover.png" }));
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Gallery" }).click();
  const gallery = page.getByRole("list", { name: "Gallery gallery" });
  const card = (name: string) => gallery.getByRole("listitem", { name });
  const img = card("Review workspace navigation").locator(".db-cover img");
  await expect(img).toHaveAttribute("src", "/api/attachments/a_cover1");
  await expect(img).toHaveCSS("object-position", /50% 20%/);
  await expect(img).toHaveCSS("object-fit", "cover");
  const gradient = card("Write release notes").locator(".db-cover-gradient");
  await expect(gradient).toBeVisible();
  expect(await gradient.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  await expect(card("Refine onboarding copy").locator(".db-cover img, .db-cover-gradient")).toHaveCount(0);
  // A cover that is not ours / https never becomes an <img> (no javascript:, no arbitrary same-origin path).
  expect(await gallery.locator('.db-cover img:not([src^="/api/attachments/"]):not([src^="https://"])').count()).toBe(0);
});

// NP-DB-14 — multi-level sort from the Sort menu, saved per view.
test("multi-level sort", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  const sort = page.getByRole("dialog", { name: "Sort" });
  await sort.getByRole("button", { name: /Add sort/ }).click();
  await sort.getByLabel("Sort 1 property").selectOption("priority");
  await sort.getByLabel("Sort 1 direction").selectOption("desc");
  await sort.getByRole("button", { name: /Add sort/ }).click();
  await sort.getByLabel("Sort 2 property").selectOption("due");
  await sort.getByLabel("Sort 2 direction").selectOption("desc");
  const titles = () => table.locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.querySelector("button")?.textContent?.trim() ?? "").filter(Boolean));
  const pos = async (title: string) => (await titles()).indexOf(title);
  // Level 1 groups the two high-priority rows together; level 2 orders them by due date, newest first.
  await expect.poll(async () => (await pos("Write release notes")) - (await pos("Review workspace navigation"))).toBe(-1);
  const saved = (await configWrites(page)).at(-1).metadata.prism_database.views[0].sort;
  expect(saved).toEqual([{ key: "priority", dir: "desc" }, { key: "due", dir: "desc" }]);
  // Flipping only the second level reorders inside the group and leaves the first level alone.
  await sort.getByLabel("Sort 2 direction").selectOption("asc");
  await expect.poll(async () => (await pos("Write release notes")) - (await pos("Review workspace navigation"))).toBe(1);
  expect((await configWrites(page)).at(-1).metadata.prism_database.views[0].sort).toEqual([{ key: "priority", dir: "desc" }, { key: "due", dir: "asc" }]);
  // Per view: the Board view has no sort of its own.
  expect((await configWrites(page)).at(-1).metadata.prism_database.views[1].sort).toBeUndefined();
  // Removing a level is saved too.
  await sort.getByRole("button", { name: "Remove sort 1" }).click();
  await expect.poll(async () => (await configWrites(page)).at(-1).metadata.prism_database.views[0].sort).toEqual([{ key: "due", dir: "asc" }]);
});

// NP-DB-16 — saved views can be renamed and deleted (duplicate and reorder are product gaps, see PARITY-EVIDENCE.md).
test("a saved view is renamed and deleted from View settings", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("tab", { name: "All tasks" })).toBeVisible();
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  await settings.getByLabel("View name").fill("Everything");
  await settings.getByLabel("View name").blur();
  await expect(page.getByRole("tab", { name: "Everything" })).toBeVisible();
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].name).toBe("Everything");
  const before = (await configWrites(page)).at(-1).metadata.prism_database.views.length;
  await settings.getByRole("button", { name: "Delete view" }).click();
  await expect(page.getByRole("tab", { name: "Everything" })).toHaveCount(0);
  await expect.poll(async () => (await configWrites(page)).at(-1).metadata.prism_database.views.length).toBe(before - 1);
  await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
});

// NP-DB-03 — arrows move between cells, Enter edits, Esc cancels back to the cell, Tab commits and moves on; columns reorder.
test("column reorder and cell keyboard nav", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");
  const focusedRow = () => page.evaluate(() => document.activeElement?.closest("tr")?.getAttribute("data-row-id") ?? "");
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Status: in-progress" }).focus();
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("Priority: medium");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("Refine onboarding copy");
  await page.keyboard.press("ArrowLeft"); // already at the first column: stays put
  expect(await focused()).toBe("Refine onboarding copy");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("Estimate (h): 5");

  // Enter edits; Esc cancels without writing and returns to the cell.
  const before = (await writes(page)).length;
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Estimate (h)" });
  await expect(input).toBeFocused();
  await input.fill("9");
  await page.keyboard.press("ArrowLeft"); // arrows inside an editor move the caret, not the cell
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  expect(await focused()).toBe("Estimate (h): 5");
  expect((await writes(page)).length).toBe(before);

  // Enter commits and stays on the cell; ArrowDown/Up move along the column.
  await page.keyboard.press("Enter");
  await input.fill("9");
  await page.keyboard.press("Enter");
  await expect.poll(focused).toBe("Estimate (h): 9");
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { estimate: 9 }, expect: { estimate: 5 } });
  const here = await focusedRow();
  await page.keyboard.press("ArrowDown");
  expect(await focused()).toMatch(/^Estimate \(h\):/);
  expect(await focusedRow()).not.toBe(here);
  await page.keyboard.press("ArrowUp");
  expect(await focusedRow()).toBe(here);

  // Tab commits the edit and moves to the next cell.
  await page.keyboard.press("Enter");
  await input.fill("4");
  await page.keyboard.press("Tab");
  await expect.poll(async () => (await writes(page)).at(-1)).toEqual({ id: "t3", set: { estimate: 4 }, expect: { estimate: 9 } });
  await expect.poll(focused).toMatch(/^Labels:/);
  expect(await focusedRow()).toBe(here);

  // Columns reorder from View settings and the order is saved.
  const headers = () => table.locator("thead th").allInnerTexts();
  expect((await headers()).slice(0, 3)).toEqual(["Title", "Status", "Priority"]);
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByRole("button", { name: "Move Priority earlier" }).click();
  await expect.poll(async () => (await headers()).slice(0, 3)).toEqual(["Title", "Priority", "Status"]);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].visible.slice(0, 2)).toEqual(["priority", "status"]);
});

// NP-DB-01 — a database is created from the New page menu, or from a tag; either way it starts as a Table over that tag.
test("create database from New page and from tag", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Page", exact: true }).click();
  await dialog.getByRole("button", { name: "Database", exact: true }).click();
  await dialog.getByRole("textbox").first().fill("Roadmap");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = (await fx(page)).creates.at(-1);
  expect(created.path).toBe("Projects/Roadmap");
  expect(created.metadata.prism_type).toBe("database");
  expect(created.tags ?? []).toEqual([]);
  // The new page asks which pages it shows, then opens as a Table view over that tag.
  await expect(page.getByRole("heading", { name: "Which pages should this database show?" })).toBeVisible();
  await page.getByLabel("Source tag").fill("task");
  await page.getByRole("button", { name: "Create database" }).click();
  await expect(page.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "Table" }).getByRole("button", { name: "Write release notes", exact: true })).toBeVisible();
  expect((await configWrites(page)).at(-1).metadata.prism_database).toEqual({ version: 1, source: { tags: ["task"] }, views: [{ id: "table", name: "Table", type: "table" }] });

  // From a tag: "Open as database" creates Databases/<tag> once, then reopens it.
  await page.getByRole("button", { name: "Open as database" }).click();
  await expect.poll(async () => (await fx(page)).creates.at(-1)?.path).toBe("Databases/task");
  const fromTag = (await fx(page)).creates.at(-1);
  expect(fromTag.metadata.prism_database).toEqual({ version: 1, source: { tags: ["task"] }, views: [{ id: "table", name: "Table", type: "table" }] });
  await expect(page.getByRole("heading", { name: "task", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Table" }).getByRole("button", { name: "Write release notes", exact: true })).toBeVisible();
  const count = (await fx(page)).creates.length;
  await page.getByRole("button", { name: "Open as database" }).click();
  await expect(page.getByRole("table", { name: "Table" })).toBeVisible();
  expect((await fx(page)).creates.length).toBe(count);
});

// NP-DB-16 — a view is duplicated with every setting, and tabs reorder (buttons and drag); both are saved to the database note.
test("saved views: duplicate and reorder tabs", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const tabs = () => page.getByRole("tablist", { name: "Views" }).getByRole("tab").allInnerTexts().then((t) => t.map((x) => x.trim()).filter(Boolean));
  const savedViews = async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views as any[] | undefined;
  await page.getByRole("tab", { name: "Board" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  await settings.getByRole("button", { name: "Duplicate view" }).click();
  // The copy sits right after its source, is selected, and keeps the layout, grouping and properties.
  await expect.poll(tabs).toEqual(["All tasks", "Board", "Board copy", "Gallery", "List", "Calendar"]);
  await expect(page.getByRole("tab", { name: "Board copy" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await savedViews())?.length).toBe(6);
  const [src, copy] = [(await savedViews())![1], (await savedViews())![2]];
  expect(copy).toEqual({ ...src, id: copy.id, name: "Board copy" });
  expect(copy.id).not.toBe(src.id);
  await expect(page.getByRole("list", { name: "Board copy board" })).toBeVisible();
  // Changing the copy leaves the source alone.
  await settings.getByLabel("Group by").selectOption("priority");
  await expect.poll(async () => (await savedViews())!.map((v) => v.groupBy).slice(1, 3)).toEqual(["status", "priority"]);

  // Reorder with the buttons…
  await settings.getByRole("button", { name: "Move view left" }).click();
  await expect.poll(tabs).toEqual(["All tasks", "Board copy", "Board", "Gallery", "List", "Calendar"]);
  await settings.getByRole("button", { name: "Move view left" }).click();
  await expect.poll(tabs).toEqual(["Board copy", "All tasks", "Board", "Gallery", "List", "Calendar"]);
  await expect(settings.getByRole("button", { name: "Move view left" })).toBeDisabled();
  await expect.poll(async () => (await savedViews())!.map((v) => v.name)).toEqual(["Board copy", "All tasks", "Board", "Gallery", "List", "Calendar"]);
  await page.keyboard.press("Escape");
  // …and by dragging a tab onto another.
  await page.getByRole("tab", { name: "Calendar" }).dragTo(page.getByRole("tab", { name: "All tasks" }));
  await expect.poll(tabs).toEqual(["Board copy", "Calendar", "All tasks", "Board", "Gallery", "List"]);
  await expect.poll(async () => (await savedViews())!.map((v) => v.name)).toEqual(["Board copy", "Calendar", "All tasks", "Board", "Gallery", "List"]);
  // The order survives a reload (it lives in the database note).
  await page.reload();
  await expect.poll(tabs).toEqual(["Board copy", "Calendar", "All tasks", "Board", "Gallery", "List"]);
});

test("viewer: duplicating or reordering a view stays in this tab", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  await settings.getByRole("button", { name: "Duplicate view" }).click();
  await expect(page.getByRole("tab", { name: "All tasks copy" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("You can’t edit this database, so view changes stay in this tab.")).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  await expect(page.getByRole("tab", { name: "All tasks", exact: true })).toHaveAttribute("draggable", "false");
});
