import { test, expect, type Page } from "@playwright/test";

const fx = (page: Page) => page.evaluate(() => { const f = (window as any).dbFixture; return { creates: f.creates, schemaWrites: f.schemaWrites }; });
const writes = (page: Page) => page.evaluate(() => (window as any).dbFixture.writes);
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });

test("table: typed cells edit in place with per-field compare-and-set, and conflicts are recoverable", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("row")).toHaveCount(1 + 7 + 1 + 1); // header, 7 rows, + New, the calculations footer
  // The footer's first cell counts the rows; "7 pages" under the table would say it twice (w16).
  await expect(table.locator("tfoot").getByRole("rowheader")).toHaveAccessibleName("Count: 7");
  await expect(page.getByText("7 pages")).toHaveCount(0);
  // Option names are words from the schema ("In progress", "To do"), not CSS on the stored value —
  // nothing is capitalised by a stylesheet any more (a free tag shows as typed) (w16).
  await expect(table.getByRole("button", { name: "Status: In progress" }).first()).toBeVisible();
  expect(await page.locator(".db-opt-text").evaluateAll((els) => els.filter((e) => getComputedStyle(e, "::first-letter").textTransform === "uppercase").length)).toBe(0);

  // Select: pick an option from the schema enum.
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Status: In progress" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "Done" }).click();
  await expect(row(page, "Refine onboarding copy").getByRole("button", { name: "Status: Done" })).toBeVisible();
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
  await row(page, "Write release notes").getByRole("button", { name: "Priority: High" }).click();
  await page.getByRole("dialog", { name: "Choose Priority" }).getByRole("option", { name: "Medium" }).click();
  const alert = row(page, "Write release notes").getByRole("alert");
  await expect(alert).toContainText("Changed elsewhere to “Low”");
  await alert.getByRole("button", { name: "Keep mine" }).click();
  await expect(row(page, "Write release notes").getByRole("button", { name: "Priority: Medium" })).toBeVisible();
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
  await expect(table.getByRole("row")).toHaveCount(1 + 2 + 1 + 1);
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
  expect(created).toMatchObject({ tags: ["task"], path: "Projects/Launch plan/Ship the changelog", metadata: { status: "todo" } });
  // NP-DB-20: the row's name is its path — no stored copy of it that a rename would leave behind.
  expect(created.metadata.title).toBeUndefined();

  await page.getByRole("tab", { name: "Board" }).click();
  const done = page.getByRole("region", { name: "Done", exact: true });
  await done.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("textbox", { name: "New page in Done" }).fill("Archive old docs");
  await page.keyboard.press("Enter");
  await expect(done.getByRole("article", { name: "Archive old docs" })).toBeVisible();
  expect((await fx(page)).creates.at(-1)).toMatchObject({ path: "Projects/Launch plan/Archive old docs", metadata: { status: "done" } });

  // A failed create keeps the typed title.
  await page.evaluate(() => { (window as any).dbFixture.failNext = true; });
  await done.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("textbox", { name: "New page in Done" }).fill("Retry me");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "could not be created" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "New page in Done" })).toHaveValue("Retry me");
});

test("board: move by menu and by drag writes the group property, rank stays view-local", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Board" }).click();
  const todo = page.getByRole("region", { name: "To do", exact: true });
  const inProgress = page.getByRole("region", { name: "In progress", exact: true });
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(todo.getByRole("article")).toHaveCount(2);

  await page.getByRole("button", { name: "Actions for Review workspace navigation" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "Done" }).click();
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
  await expect(page.getByText("only pages you can see", { exact: true })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Count: 6" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Private planning note" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a view" })).toHaveCount(0);
  await row(page, "Write release notes").getByRole("button", { name: "Status: In progress" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Status" })).toHaveCount(0);
  await page.getByRole("button", { name: "Due", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect(page.getByRole("status").filter({ hasText: "view changes stay in this tab" })).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  expect((await writes(page)).length).toBe(0);
});

test("legacy shell: bundled schemas + listNotes fallback, metadata-only CAS writes", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?legacy");
  await expect(page.getByRole("table", { name: "All tasks" }).getByRole("row")).toHaveCount(1 + 7 + 1 + 1);
  await row(page, "Update pricing page").getByRole("button", { name: "Status: Done" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "To do" }).click();
  await expect(row(page, "Update pricing page").getByRole("button", { name: "Status: To do" })).toBeVisible();
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
  await row(page, "Write release notes").getByRole("button", { name: "Status: In progress" }).click();
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
  await expect(page.getByRole("rowheader", { name: "Count: 7" })).toBeVisible();
  await page.getByLabel("Search this database").pressSequentially("release", { delay: 40 });
  await expect(page.getByRole("rowheader", { name: "Count: 1" })).toBeVisible();
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

  // Card size S / M / L (NP-DB-05): saved per view, and it really changes the cards.
  const width = async () => (await card("Review workspace navigation").boundingBox())!.width;
  const coverHeight = async () => (await card("Review workspace navigation").locator(".db-cover").boundingBox())!.height;
  const [mediumW, mediumH] = [await width(), await coverHeight()];
  await expect(gallery).toHaveAttribute("data-size", "medium");
  await page.getByRole("button", { name: "View settings" }).click();
  const size = page.getByRole("dialog", { name: "View settings" }).getByLabel("Card size");
  await expect(size).toHaveValue("medium");
  await size.selectOption("large");
  await expect(gallery).toHaveAttribute("data-size", "large");
  await expect.poll(width).toBeGreaterThan(mediumW);
  expect(await coverHeight()).toBeGreaterThan(mediumH);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[2].cardSize).toBe("large");
  await size.selectOption("small");
  await expect(gallery).toHaveAttribute("data-size", "small");
  await expect.poll(width).toBeLessThan(mediumW);
  expect(await coverHeight()).toBeLessThan(mediumH);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[2].cardSize).toBe("small");
  // The cover still fills the card at every size, and the choice survives a reload.
  await expect(img).toHaveCSS("object-fit", "cover");
  await page.reload();
  await page.getByRole("tab", { name: "Gallery" }).click();
  await expect(page.getByRole("list", { name: "Gallery gallery" })).toHaveAttribute("data-size", "small");
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
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Status: In progress" }).focus();
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("Priority: Medium");
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
  // Shift+Tab walks back to the cell that was edited (the table moves focus itself: no browser setting needed).
  await page.keyboard.press("Shift+Tab");
  await expect.poll(focused).toBe("Estimate (h): 4");
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
  // (The New database dialog — its own tag + properties — offers the older page as "Use an existing tag".)
  await page.getByRole("dialog", { name: "New database" }).getByRole("button", { name: "Use an existing tag" }).click();
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

// NP-DB-04 — board groups by select / status / person; empty groups can be hidden; cards open, move and reorder from their menu.
test("board: hide empty groups, group by person, card menu order and open", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Board" }).click();
  const board = page.getByRole("list", { name: "Board board" });
  const columns = () => board.getByRole("region").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  await settings.getByLabel("Group by").selectOption("priority");
  // "blocked" is an option nobody uses: an empty column.
  await expect.poll(columns).toEqual(["Low", "Medium", "High", "Blocked"]);
  await expect(board.getByRole("region", { name: "Blocked" })).toContainText("No pages");
  await settings.getByRole("checkbox", { name: "Hide empty groups" }).check();
  await expect.poll(columns).toEqual(["Low", "Medium", "High"]);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[1]).toMatchObject({ groupBy: "priority", hideEmptyGroups: true });
  // A group that becomes empty disappears; one that gains a page comes back.
  await page.keyboard.press("Escape");
  for (const title of ["Update pricing page", "Private planning note"]) {
    await page.getByRole("button", { name: `Actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Medium" }).click();
    await expect(board.getByRole("region", { name: "Medium" }).getByRole("article", { name: title })).toBeVisible();
  }
  await expect.poll(columns).toEqual(["Medium", "High"]);
  await page.getByRole("button", { name: "View settings" }).click();
  await settings.getByRole("checkbox", { name: "Hide empty groups" }).uncheck();
  await expect.poll(columns).toEqual(["Low", "Medium", "High", "Blocked"]);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[1].hideEmptyGroups).toBeUndefined();

  // Group by a person property.
  await settings.getByLabel("Group by").selectOption("assignee");
  await expect.poll(async () => (await columns()).slice().sort()).toEqual(["Mira Chen", "No Assignee", "Sam Rivera"]);
  expect((await columns())[0]).toBe("No Assignee"); // the empty group leads
  await expect(board.getByRole("region", { name: "Mira Chen" }).getByRole("article")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Card menu: Move later reorders inside the column (view-local rank), Open opens the page.
  const none = board.getByRole("region", { name: "No Assignee" });
  const order = () => none.getByRole("article").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const first = (await order())[0]!;
  await page.getByRole("button", { name: `Actions for ${first}` }).click();
  await page.getByRole("menuitem", { name: "Move later" }).click();
  await expect.poll(async () => (await order())[1]).toBe(first);
  await expect.poll(async () => Array.isArray((await configWrites(page)).at(-1)?.metadata.prism_database.views[1].order)).toBe(true);
  await page.getByRole("button", { name: `Actions for ${first}` }).click();
  await page.getByRole("menuitem", { name: "Open" }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(first) })).toBeVisible();
  // Grouped tables hide empty groups the same way.
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "All tasks" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await settings.getByLabel("Group by").selectOption("priority");
  await expect(page.getByRole("region", { name: "Blocked" })).toBeVisible();
  await settings.getByRole("checkbox", { name: "Hide empty groups" }).check();
  await expect(page.getByRole("region", { name: "Blocked" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "High" })).toBeVisible();
});

// NP-DB-23 — on a phone a board opens as a grouped list (the saved view is untouched); the board is one tap away.
test("phone: boards default to list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.getByText("Shown as a list on this screen.")).toBeVisible();
  await expect(page.locator(".db-board")).toHaveCount(0);
  const todo = page.getByRole("region", { name: "To do", exact: true });
  await expect(todo.getByRole("list", { name: "To do list" }).getByRole("button", { name: "Review workspace navigation" })).toBeVisible();
  await expect(page.getByRole("region", { name: "In progress", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Rows open full-page on a phone.
  await todo.getByRole("button", { name: "Review workspace navigation" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toContain("t1");
  await page.evaluate(() => { const s = (window as any).prismUI.getState(); s.setActiveTab(s.openTabs[0].id); });
  await page.getByRole("tab", { name: "Board" }).click();
  // One tap shows the real board; nothing about the view is rewritten.
  await page.getByRole("button", { name: "Show as board" }).click();
  await expect(page.locator(".db-board")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show as list" })).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  // A wide screen gets the board straight away.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.locator(".db-board")).toBeVisible();
  await expect(page.getByText("Shown as a list on this screen.")).toHaveCount(0);
});

// NP-AX-07 — on a phone the calendar is a week LIST (a day per row, 44 px targets); the month grid is one tap away
// and the saved view is untouched. A page is rescheduled there with its date editor.
test("phone: the calendar defaults to a week list — day rows, week navigation, the date editor reschedules; Month shows the grid", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html?ingest");
  await expect(page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first()).toBeVisible();
  const ymd = (off: number) => page.evaluate((o) => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + o); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }, off);
  const [today, nextWeek] = [await ymd(0), await ymd(7)];
  await page.evaluate(([today, nextWeek]) => {
    const notes = (window as any).dbFixture.notes();
    const set = (id: string, due: string | null) => { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, due }; };
    set("t1", today!); set("g1", today!); set("t2", nextWeek!); set("t3", null); set("t4", null); set("t5", null); set("g2", null); set("g3", null); set("g4", null);
  }, [today, nextWeek]);
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByText("Shown as a week list on this screen.")).toBeVisible();
  await expect(page.locator(".db-cal")).toHaveCount(0);
  const week = page.getByRole("list", { name: "Calendar week" });
  const days = week.locator("> li");
  await expect(days).toHaveCount(7);
  // Monday first; today is marked, and holds today's pages as full-width rows.
  expect(await days.first().evaluate((li) => new Date(`${li.getAttribute("data-day")}T12:00:00`).getDay())).toBe(1);
  const todayRow = week.locator(`> li[data-day="${today}"]`);
  await expect(todayRow).toHaveAttribute("aria-current", "date");
  await expect(todayRow).toContainText("Today");
  const item = todayRow.locator('[data-agenda-item="t1"]');
  await expect(item.getByRole("button", { name: "Review workspace navigation", exact: true })).toBeVisible();
  // Every control in the list is a real touch target, and nothing overflows the screen.
  const small = await week.locator("button, input, select, a[href]").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { what: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((b) => b.w > 0 && (b.w < 44 || b.h < 44)));
  expect(small).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const row of await days.all()) expect((await row.boundingBox())!.width).toBeGreaterThan(330);

  // The date editor reschedules (no dragging on a phone): a per-field compare-and-set write.
  await item.getByRole("button", { name: /^Due: / }).click();
  await item.getByLabel("Due", { exact: true }).fill(nextWeek);
  await item.getByLabel("Due", { exact: true }).press("Enter");
  await expect.poll(async () => (await writes(page)).filter((w: any) => w.set).at(-1)).toMatchObject({ id: "t1", set: { due: nextWeek }, expect: { due: today } });
  await expect(todayRow.locator('[data-agenda-item="t1"]')).toHaveCount(0);
  // A page an integration keeps in sync is listed, opens, and says why its date is not changed here.
  const synced = todayRow.locator('[data-agenda-item="g1"]');
  await expect(synced).toContainText("kept in sync by an integration");
  await synced.getByRole("button", { name: /^Due: / }).click();
  await expect(synced.getByLabel("Due", { exact: true })).toHaveCount(0);

  // Week navigation: next week holds what was moved there (and t2); Today comes back.
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(week.locator(`> li[data-day="${nextWeek}"]`).getByRole("button", { name: "Review workspace navigation", exact: true })).toBeVisible();
  await expect(week.locator(`> li[data-day="${nextWeek}"]`).getByRole("button", { name: "Write release notes", exact: true })).toBeVisible();
  await expect(week.locator(`> li[data-day="${today}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Previous week" }).click();
  await page.getByRole("button", { name: "Previous week" }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(week.locator(`> li[data-day="${today}"]`)).toHaveAttribute("aria-current", "date");

  // Adding on a day sets that day.
  await todayRow.getByRole("button", { name: `New page on ${today}` }).click();
  await page.getByRole("textbox", { name: `New page on ${today}` }).fill("Standup notes");
  await page.keyboard.press("Enter");
  await expect(todayRow.getByRole("button", { name: "Standup notes", exact: true })).toBeVisible();
  expect((await fx(page)).creates.at(-1).metadata.due).toBe(today);

  // "Month" shows the dense grid as before; nothing about the saved view is written either way.
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.getByRole("grid", { name: "Calendar calendar" })).toBeVisible();
  await expect(page.getByText("Month grid: days are small on this screen.")).toBeVisible();
  await expect(week).toHaveCount(0);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(week).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  // A wide screen gets the month grid straight away, with no notice.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("grid", { name: "Calendar calendar" })).toBeVisible();
  await expect(page.getByText("Shown as a week list on this screen.")).toHaveCount(0);
});

// NP-DB-07 — a calendar item is dragged to another day (CAS write through the property writer); a range spans as one bar.
test("calendar drag reschedule and multi-day span", async ({ page }) => {
  // Dates inside the current month, starting on a Monday so a three-day range sits in one week row.
  const now = new Date();
  const mon = new Date(now.getFullYear(), now.getMonth(), 8);
  while (mon.getDay() !== 1) mon.setDate(mon.getDate() + 1);
  const d = (off: number) => { const x = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + off); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  // Tall enough that the whole month is on screen (a drag near the edge auto-scrolls, as it should).
  await page.setViewportSize({ width: 1280, height: 1300 });
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("table", { name: "All tasks" })).toBeVisible();
  await page.evaluate(([range, single, cross]) => {
    const notes = (window as any).dbFixture.notes();
    const set = (id: string, due: string | null) => { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, due }; };
    set("t3", range); set("t2", single); set("t4", cross); set("t1", null); set("t5", null);
  }, [`${d(0)}/${d(2)}`, d(3), `${d(5)}/${d(8)}`]);
  await page.getByRole("tab", { name: "Calendar" }).click();
  const cal = page.getByRole("grid", { name: "Calendar calendar" });
  const cell = (day: string) => cal.locator(`[data-day="${day}"]`);
  const box = async (l: ReturnType<typeof cell>) => (await l.boundingBox())!;

  // A three-day range is ONE bar across its three day cells.
  const bar = cal.locator('.db-cal-bar[data-cal-item="t3"]');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAccessibleName(/^Refine onboarding copy, .+ → .+/);
  const [b, first, last] = [await box(bar), await box(cell(d(0))), await box(cell(d(2)))];
  expect(b.x).toBeGreaterThanOrEqual(first.x);
  expect(b.x + b.width).toBeLessThanOrEqual(last.x + last.width + 1);
  expect(b.width).toBeGreaterThan(first.width * 2.5);
  await expect(cell(d(1)).locator(".db-cal-item")).toHaveCount(0); // not repeated per day
  // A range crossing the weekend continues on the next week row: two pieces of the same item.
  const crossing = cal.locator('.db-cal-bar[data-cal-item="t4"]');
  await expect(crossing).toHaveCount(2);
  expect((await box(crossing.first())).x).toBeGreaterThanOrEqual((await box(cell(d(5)))).x);
  expect((await box(crossing.nth(1))).x).toBeLessThan((await box(cell(d(8)))).x);

  const drag = async (from: ReturnType<typeof cell>, toDay: string) => {
    const a = await box(from);
    const t = await box(cell(toDay));
    await page.mouse.move(a.x + Math.min(20, a.width / 2), a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 30, a.y + a.height / 2 + 12, { steps: 4 });
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 14, { steps: 12 });
    await page.mouse.up();
  };
  // Drag a single-day item to the next day: one CAS property write.
  await drag(cell(d(3)).locator('[data-cal-item="t2"]'), d(4));
  await expect.poll(async () => (await writes(page)).at(-1)).toEqual({ id: "t2", set: { due: d(4) }, expect: { due: d(3) } });
  await expect(cell(d(4)).locator('[data-cal-item="t2"]')).toBeVisible();
  await expect(cell(d(3)).locator('[data-cal-item="t2"]')).toHaveCount(0);
  // Drag the bar a week later: the whole range moves and keeps its length.
  await drag(bar, d(7));
  await expect.poll(async () => (await writes(page)).at(-1)).toEqual({ id: "t3", set: { due: `${d(7)}/${d(9)}` }, expect: { due: `${d(0)}/${d(2)}` } });
  // Changed elsewhere meanwhile: refused, said so, and nothing is overwritten.
  await page.evaluate((v) => { (window as any).dbFixture.conflictWith = v; }, d(10));
  await drag(cell(d(4)).locator('[data-cal-item="t2"]'), d(6));
  await expect(page.getByRole("alert")).toContainText("“Write release notes” was changed somewhere else, so it was not moved.");
  expect(await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t2").metadata.due)).toBe(d(10));

  // A clicked item still opens (a click is not a drag).
  await cell(d(10)).locator('[data-cal-item="t2"]').click();
  await expect(page.getByRole("dialog", { name: /Write release notes/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // Month navigation.
  const heading = cal.locator("xpath=preceding-sibling::*").first();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator(".db-cal-head").getByRole("heading")).not.toHaveText(now.toLocaleDateString("en-US", { month: "long", year: "numeric" }));
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(cell(d(7))).toBeVisible();
  void heading;
});

test("calendar: a viewer cannot drag an item to another day", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await page.getByRole("tab", { name: "Calendar" }).click();
  const item = page.locator("[data-cal-item]").first();
  await expect(item).toBeVisible();
  const a = (await item.boundingBox())!;
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 200, a.y + 160, { steps: 10 });
  await page.mouse.up();
  expect((await writes(page)).filter((w: any) => !w.metadata?.prism_database)).toEqual([]);
});

// Review L8 — a page an integration keeps in sync is never rescheduled by a drag; the chip says why.
test("L8: calendar drag is off for calendar-synced, ClickUp and ingest-sourced rows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1300 });
  await page.goto("/e2e-fixtures/databases.html?ingest");
  await page.getByRole("tab", { name: "Calendar" }).click();
  const cal = page.getByRole("grid", { name: "Calendar calendar" });
  for (const id of ["g1", "g2", "g3"]) {
    const chip = cal.locator(`[data-cal-item="${id}"]`);
    await expect(chip).toHaveAttribute("data-locked", "");
    await expect(chip).toHaveAttribute("title", /kept in sync by an integration/);
    const a = (await chip.boundingBox())!;
    await page.mouse.move(a.x + 10, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 20, { steps: 4 });
    await page.mouse.move(a.x + 10, a.y + 260, { steps: 10 });
    await page.mouse.up();
  }
  expect((await writes(page)).filter((w: any) => w.set)).toEqual([]);
  // Long-press / context menu explains it too.
  await cal.locator('[data-cal-item="g1"]').dispatchEvent("contextmenu");
  await expect(page.getByRole("alert")).toContainText("“Synced standup” is kept in sync by an integration");
  // An ordinary page (its `source` is just a word) still moves.
  const free = cal.locator('[data-cal-item="g4"]');
  await expect(free).not.toHaveAttribute("data-locked", "");
  const a = (await free.boundingBox())!;
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 20, { steps: 4 });
  await page.mouse.move(a.x + 10, a.y + 260, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await writes(page)).filter((w: any) => w.set).at(-1)?.id).toBe("g4");
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
