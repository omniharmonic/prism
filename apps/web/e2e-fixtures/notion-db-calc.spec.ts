import { test, expect, type Page } from "@playwright/test";

/**
 * Notion parity — table calculations (NP-DB-26), with the same figures in board
 * columns and list / gallery footers. Fixture: databases.html, whose `queryNotes`
 * runs the server's own pure engine.
 */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const writes = async (page: Page) => (await fx(page)).writes as any[];
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);
const table = (page: Page, name = "All tasks") => page.getByRole("table", { name });
const footer = (page: Page, name = "All tasks") => table(page, name).locator("tfoot");
/** What the fixture's rows hold (what the viewer may see), for expected figures. */
const rowsOf = (page: Page, opts: { viewer?: boolean } = {}) => page.evaluate((viewer) =>
  ((window as any).dbFixture.notes() as any[]).filter((n) => n.tags?.includes("task") && !n.tags.includes("prism-trashed") && !(viewer && n.metadata?.prism_visibility === "private")), !!opts.viewer);
const sum = (rows: any[], key: string) => rows.reduce((s, n) => s + (typeof n.metadata[key] === "number" ? n.metadata[key] : 0), 0);
const settings = (page: Page) => page.getByRole("dialog", { name: "View settings" });

async function choose(page: Page, property: string, fn: string, scope = footer(page)) {
  await scope.getByRole("button", { name: `Calculate ${property}`, exact: true }).click();
  await page.getByRole("menuitemradio", { name: fn, exact: true }).click();
}

test("table: choose a calculation per column; it is saved with the view and survives a reload", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  const foot = footer(page);
  // The frozen first cell is the row count.
  await expect(foot.getByRole("rowheader")).toHaveText(`Count${rows.length}`);
  await expect(foot.getByRole("rowheader")).toHaveAccessibleName(`Count: ${rows.length}`);
  await expect(page.locator(".db-count")).toHaveText(`${rows.length} pages`);

  // "Calculate" appears on hover / focus; the menu is grouped by family and follows the property type.
  const estimate = foot.getByRole("button", { name: "Calculate Estimate (h)", exact: true });
  await expect(estimate.locator(".db-calc-prompt")).toHaveCSS("opacity", "0");
  await estimate.hover();
  await expect(estimate.locator(".db-calc-prompt")).toHaveCSS("opacity", "1");
  await estimate.click();
  const menu = page.getByRole("menu", { name: "Calculate Estimate (h)" });
  await expect(menu.getByRole("group", { name: "Count" }).getByRole("menuitemradio")).toHaveText(["Count all", "Count values", "Count unique values", "Count empty", "Count not empty"]);
  await expect(menu.getByRole("group", { name: "Percent" }).getByRole("menuitemradio")).toHaveText(["Percent empty", "Percent not empty"]);
  await expect(menu.getByRole("group", { name: "Number" }).getByRole("menuitemradio")).toHaveText(["Sum", "Average", "Median", "Min", "Max", "Range"]);
  await expect(menu.getByRole("group", { name: "Date" })).toHaveCount(0);
  await expect(menu.getByRole("menuitemradio", { name: "None" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Sum", exact: true }).click();

  const total = sum(rows, "estimate");
  const chosen = foot.getByRole("button", { name: `Sum of Estimate (h): ${total}`, exact: true });
  await expect(chosen).toBeVisible();
  await expect(chosen).toHaveText(`Sum${total}`);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].calculations).toEqual({ estimate: "sum" });

  // Other property types offer their own family.
  await foot.getByRole("button", { name: "Calculate Due", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Calculate Due" }).getByRole("group", { name: "Date" }).getByRole("menuitemradio")).toHaveText(["Earliest date", "Latest date", "Date range"]);
  await expect(page.getByRole("menu", { name: "Calculate Due" }).getByRole("group", { name: "Number" })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "Date range" }).click();
  const due = rows.map((n) => n.metadata.due).filter(Boolean).sort();
  const days = Math.round((Date.parse(due.at(-1)) - Date.parse(due[0])) / 86_400_000);
  await expect(foot.getByRole("button", { name: `Date range of Due: ${days} days`, exact: true })).toBeVisible();
  await foot.getByRole("button", { name: "Calculate Flagged", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Calculate Flagged" }).getByRole("group", { name: "Checkbox" }).getByRole("menuitemradio")).toHaveText(["Checked", "Unchecked", "Percent checked"]);
  await page.getByRole("menuitemradio", { name: "Percent checked" }).click();
  const checked = rows.filter((n) => n.metadata.flagged === true).length;
  await expect(foot.getByRole("button", { name: /^Percent checked in Flagged: / })).toHaveText(`Checked${(checked / rows.length).toLocaleString("en-US", { style: "percent", maximumFractionDigits: 1 })}`);
  await choose(page, "Status", "Count unique values");
  await expect(foot.getByRole("button", { name: "Unique values in Status: 3", exact: true })).toBeVisible();
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].calculations).toEqual({ estimate: "sum", due: "date_range", flagged: "percent_checked", status: "count_unique" });

  // A figure follows the data: an edit to a row changes it.
  await page.locator("tr", { has: page.getByRole("button", { name: "Refine onboarding copy", exact: true }) }).getByRole("button", { name: "Estimate (h): 5" }).click();
  await page.getByRole("textbox", { name: "Estimate (h)" }).fill("8");
  await page.keyboard.press("Enter");
  await expect(foot.getByRole("button", { name: `Sum of Estimate (h): ${total + 3}`, exact: true })).toBeVisible();

  // Saved with the view: still there after a reload; "None" removes it.
  await page.reload();
  await expect(footer(page).getByRole("button", { name: `Sum of Estimate (h): ${total + 3}`, exact: true })).toBeVisible();
  await footer(page).getByRole("button", { name: `Sum of Estimate (h): ${total + 3}`, exact: true }).click();
  await page.getByRole("menuitemradio", { name: "None" }).click();
  await expect(footer(page).getByRole("button", { name: "Calculate Estimate (h)", exact: true })).toBeVisible();
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].calculations).toEqual({ due: "date_range", flagged: "percent_checked", status: "count_unique" });
});

test("table: a figure covers the whole view, not the rows loaded so far; filter and search narrow it", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?many");
  const rows = await rowsOf(page);
  expect(rows.length).toBeGreaterThan(150);
  await expect(page.locator(".db-count")).toContainText(`Showing 100 of ${rows.length}`);
  await expect(table(page).locator("tbody tr[data-row-id]")).toHaveCount(100);
  await expect(footer(page).getByRole("rowheader")).toHaveText(`Count${rows.length}`);
  await choose(page, "Estimate (h)", "Sum");
  await expect(footer(page).getByRole("button", { name: `Sum of Estimate (h): ${sum(rows, "estimate")}`, exact: true })).toBeVisible();
  await choose(page, "Status", "Count all");
  await expect(footer(page).getByRole("button", { name: `Count of Status: ${rows.length}`, exact: true })).toBeVisible();
  // The figures are asked for separately: choosing one did not reload (or lose) the rows.
  await expect(table(page).locator("tbody tr[data-row-id]")).toHaveCount(100);

  // Search narrows the figure exactly as it narrows the rows.
  await page.getByRole("searchbox", { name: "Search this database" }).fill("Bulk task 01");
  const hits = rows.filter((n) => String(n.metadata.title).includes("Bulk task 01"));
  await expect(footer(page).getByRole("rowheader")).toHaveText(`Count${hits.length}`);
  await expect(footer(page).getByRole("button", { name: `Sum of Estimate (h): ${sum(hits, "estimate")}`, exact: true })).toBeVisible();
});

test("grouped table: each group has its own figure and the view has a grand total", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  await choose(page, "Estimate (h)", "Sum");
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByLabel("Group by").selectOption("status");
  await page.keyboard.press("Escape");
  for (const status of ["todo", "in-progress", "done"]) {
    const inGroup = rows.filter((n) => n.metadata.status === status);
    const region = page.getByRole("region", { name: status, exact: true });
    await expect(region.locator("tfoot").getByRole("rowheader")).toHaveText(`Count${inGroup.length}`);
    await expect(region.locator("tfoot").getByRole("button", { name: `Sum of Estimate (h): ${sum(inGroup, "estimate") || "—"} in ${status}`, exact: true })).toBeVisible();
  }
  const totals = page.getByRole("group", { name: "Totals for All tasks" });
  await expect(totals.locator('[data-calc="$count"]')).toHaveText(`Count${rows.length}`);
  await expect(totals.locator('[data-calc="estimate"]')).toContainText(`Sum of Estimate (h): ${sum(rows, "estimate")}`);
  // A collapsed group keeps its figure in the header.
  const done = page.getByRole("region", { name: "done", exact: true });
  await done.getByRole("button", { name: "Collapse done" }).click();
  await expect(done.locator(".db-group-head")).toContainText("Sum of Estimate (h): —");
  // Changing the figure from a group's footer changes it for every group (it is the view's).
  const todo = page.getByRole("region", { name: "todo", exact: true });
  await todo.locator("tfoot").getByRole("button", { name: /^Sum of Estimate/ }).click();
  await page.getByRole("menuitemradio", { name: "Max", exact: true }).click();
  const doing = rows.filter((n) => n.metadata.status === "in-progress" && typeof n.metadata.estimate === "number").map((n) => n.metadata.estimate as number);
  await expect(page.getByRole("region", { name: "in-progress", exact: true }).locator("tfoot").getByRole("button", { name: `Maximum of Estimate (h): ${Math.max(...doing)} in in-progress`, exact: true })).toBeVisible();
});

test("viewer: a calculation is session-only, and a page the viewer cannot see is in no figure", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  const all = await rowsOf(page);
  const mine = await rowsOf(page, { viewer: true });
  expect(mine.length).toBe(all.length - 1); // the private planning note is not theirs to see
  await expect(footer(page).getByRole("rowheader")).toHaveText(`Count${mine.length}`);
  await choose(page, "Priority", "Count values");
  await expect(footer(page).getByRole("button", { name: `Values in Priority: ${mine.filter((n) => n.metadata.priority).length}`, exact: true })).toBeVisible();
  await choose(page, "Status", "Count all");
  await expect(footer(page).getByRole("button", { name: `Count of Status: ${mine.length}`, exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "view changes stay in this tab" })).toBeVisible();
  expect(await configWrites(page)).toEqual([]);
  // Not saved: gone after a reload.
  await page.reload();
  await expect(footer(page).getByRole("button", { name: "Calculate Priority", exact: true })).toBeVisible();
  await expect(footer(page).getByRole("button", { name: /Values in Priority/ })).toHaveCount(0);
});

test("keyboard: arrow from the last row into the footer, Enter opens the menu, arrows choose", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  const last = table(page).locator("tbody tr[data-row-id]").last();
  await last.getByRole("button", { name: /^Priority:/ }).focus();
  await page.keyboard.press("ArrowDown");
  const cell = footer(page).getByRole("button", { name: "Calculate Priority", exact: true });
  await expect(cell).toBeFocused();
  await expect(cell.locator(".db-calc-prompt")).toHaveCSS("opacity", "1"); // focus shows "Calculate"
  await page.keyboard.press("ArrowRight");
  await expect(footer(page).getByRole("button", { name: "Calculate Due", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(footer(page).getByRole("button", { name: "Calculate Status", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft"); // nothing further left: focus stays
  await expect(footer(page).getByRole("button", { name: "Calculate Status", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Calculate Status" });
  await expect(menu.getByRole("menuitemradio", { name: "None" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Count all" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const chosen = footer(page).getByRole("button", { name: `Values in Status: ${rows.filter((n) => n.metadata.status).length}`, exact: true });
  await expect(chosen).toBeFocused();
  // Escape closes the menu without changing anything and returns to the cell.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Calculate Status" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Calculate Status" })).toHaveCount(0);
  await expect(chosen).toBeFocused();
  // ↑ goes back to the last row, same column.
  await page.keyboard.press("ArrowUp");
  await expect(last.getByRole("button", { name: /^Status:/ })).toBeFocused();
  // ↓ in the title column lands on the first calculation.
  await last.locator(".db-row-open").focus();
  await page.keyboard.press("ArrowDown");
  await expect(chosen).toBeFocused();
});

test("phone: the footer scrolls with the table; a board shown as a list has its figures in the group header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  const wrap = page.locator(".db-table-wrap").first();
  // "Calculate" needs no hover on a touch screen.
  const cell = footer(page).getByRole("button", { name: "Calculate Estimate (h)", exact: true });
  await cell.scrollIntoViewIfNeeded();
  await expect(cell.locator(".db-calc-prompt")).toHaveCSS("opacity", "1");
  expect((await cell.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await cell.click();
  await page.getByRole("menuitemradio", { name: "Sum", exact: true }).click();
  const figure = footer(page).getByRole("button", { name: `Sum of Estimate (h): ${sum(rows, "estimate")}`, exact: true });
  await expect(figure).toBeVisible();
  // The footer is part of the table: it moves with its column, the count stays frozen with the titles.
  await wrap.evaluate((el) => { el.scrollLeft = 0; });
  const count = footer(page).getByRole("rowheader");
  const header = table(page).getByRole("button", { name: "Estimate (h)", exact: true });
  const [fx0, hx0, cx0] = [(await figure.boundingBox())!.x, (await header.boundingBox())!.x, (await count.boundingBox())!.x];
  await wrap.evaluate((el) => { el.scrollLeft = 240; });
  await expect.poll(async () => (await figure.boundingBox())!.x).toBeLessThan(fx0 - 200);
  expect(Math.round((await figure.boundingBox())!.x - (await header.boundingBox())!.x)).toBe(Math.round(fx0 - hx0));
  expect((await count.boundingBox())!.x).toBe(cx0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Board on a phone = a grouped list: the group header carries the count and the figure.
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.getByText("Shown as a list on this screen.")).toBeVisible();
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("combobox", { name: "Add a calculation" }).selectOption("estimate");
  await expect(page.getByRole("combobox", { name: "Calculation for Estimate (h)" })).toHaveValue("sum");
  await page.getByRole("button", { name: "Close sheet" }).click();
  for (const status of ["todo", "in-progress", "done"]) {
    const inGroup = rows.filter((n) => n.metadata.status === status);
    const head = page.getByRole("region", { name: status, exact: true }).locator(".db-group-head");
    await expect(head.getByLabel(`${inGroup.length} pages`)).toBeVisible();
    await expect(head.locator('[data-calc="estimate"] [data-calc-value]')).toHaveText(String(sum(inGroup, "estimate") || "—"));
  }
  await expect(page.getByRole("group", { name: "Totals for Board" }).locator('[data-calc="estimate"] [data-calc-value]')).toHaveText(String(sum(rows, "estimate")));
});

test("board, list and gallery: a count and the chosen figure per column and in the footer", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  await page.getByRole("tab", { name: "Board" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByRole("combobox", { name: "Add a calculation" }).selectOption("estimate");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views.find((v: any) => v.id === "board").calculations).toEqual({ estimate: "sum" });
  for (const status of ["todo", "in-progress", "done"]) {
    const inGroup = rows.filter((n) => n.metadata.status === status);
    const head = page.getByRole("region", { name: status, exact: true }).locator(".db-col-head");
    await expect(head.locator(".db-badge-count")).toHaveText(String(inGroup.length));
    await expect(head.locator('[data-calc="estimate"]')).toContainText(`Sum of Estimate (h): ${sum(inGroup, "estimate") || "—"}`);
  }
  // Another function for the same property, from the same place.
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByRole("combobox", { name: "Calculation for Estimate (h)" }).selectOption("average");
  await page.keyboard.press("Escape");
  const doing = rows.filter((n) => n.metadata.status === "in-progress" && typeof n.metadata.estimate === "number");
  const avg = Math.round((sum(doing, "estimate") / doing.length) * 100) / 100;
  await expect(page.getByRole("region", { name: "in-progress", exact: true }).locator('.db-col-head [data-calc="estimate"]')).toContainText(`Average of Estimate (h): ${avg}`);

  // List and gallery: no footer until a calculation is chosen; then the count and the figure.
  for (const [tab, name] of [["List", "Totals for List"], ["Gallery", "Totals for Gallery"]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("group", { name })).toHaveCount(0);
    await page.getByRole("button", { name: "View settings" }).click();
    await settings(page).getByRole("combobox", { name: "Add a calculation" }).selectOption("flagged");
    await page.keyboard.press("Escape");
    const totals = page.getByRole("group", { name });
    await expect(totals.locator('[data-calc="$count"]')).toHaveText(`Count${rows.length}`);
    await expect(totals.locator('[data-calc="flagged"]')).toContainText(`Checked in Flagged: ${rows.filter((n) => n.metadata.flagged === true).length}`);
    // Removing it removes the footer.
    await page.getByRole("button", { name: "View settings" }).click();
    await settings(page).getByRole("button", { name: "Remove calculation for Flagged" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name })).toHaveCount(0);
  }
});

test("print: the footer figure prints; an empty Calculate prompt does not", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?dark");
  await choose(page, "Estimate (h)", "Sum");
  const figure = footer(page).getByRole("button", { name: /^Sum of Estimate/ });
  await expect(figure).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(figure).toBeVisible();
  await expect(footer(page).getByRole("rowheader")).toBeVisible();
  await expect(footer(page).getByRole("button", { name: "Calculate Priority", exact: true }).locator(".db-calc-prompt")).toBeHidden();
});

const queries = async (page: Page) => (await fx(page)).queries as any[];

test("a calculation on a column the view does not show (Created by) is asked for and answered", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const rows = await rowsOf(page);
  await page.getByRole("tab", { name: "Board" }).click();
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByRole("combobox", { name: "Add a calculation" }).selectOption("prism_creator");
  await page.keyboard.press("Escape");
  // The key travels as a field, so the server answers the figure (it answers null for an access key it was not asked to show).
  await expect.poll(async () => (await queries(page)).filter((q: any) => q.aggregates?.some((a: any) => a.key === "prism_creator")).at(-1)?.fields).toContain("prism_creator");
  const made = rows.filter((n) => typeof n.metadata.prism_creator === "string" && n.metadata.prism_creator).length;
  const todo = page.getByRole("region", { name: "todo", exact: true }).locator('.db-col-head [data-calc="prism_creator"]');
  await expect(todo.locator("[data-calc-value]")).toHaveAttribute("data-calc-value", /^\d+$/);
  const perColumn = await page.locator('.db-col-head [data-calc="prism_creator"] [data-calc-value]').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-calc-value"))));
  expect(perColumn.reduce((a, b) => a + b, 0)).toBe(made);
});

test("an answer that leaves a calculation out shows — , never a figure that loads forever", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?calcomit=estimate");
  await choose(page, "Estimate (h)", "Sum");
  const cell = footer(page).getByRole("button", { name: /^Sum of Estimate/ });
  await expect(cell.locator("[data-calc-value]")).toHaveAttribute("data-calc-value", "—");
  await expect(cell).toHaveAccessibleName("Sum of Estimate (h): —");
});

test("groups cut from the answer read as not counted, not as zero; a partial figure names no row limit", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?groupcap=done&calctrunc");
  const rows = await rowsOf(page);
  await choose(page, "Status", "Count all");
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByLabel("Group by").selectOption("status");
  await page.keyboard.press("Escape");
  const todo = rows.filter((n) => n.metadata.status === "todo").length;
  const done = rows.filter((n) => n.metadata.status === "done").length;
  expect(done).toBeGreaterThan(0);
  // A group the answer holds: its figure, marked as a lower bound.
  const inTodo = page.getByRole("region", { name: "todo", exact: true }).locator("tfoot");
  const figure = inTodo.getByRole("button", { name: new RegExp(`^Count of Status: ≥ ${todo} in todo`) });
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute("title", /first pages scanned/);
  await expect(figure).not.toHaveAttribute("title", /20,000/);
  // The group the answer left out: not 0, and its row count is what is loaded, as a lower bound.
  const inDone = page.getByRole("region", { name: "done", exact: true }).locator("tfoot");
  await expect(inDone.getByRole("button", { name: /^Count of Status: not counted in done/ })).toBeVisible();
  await expect(inDone.getByRole("button", { name: /^Count of Status/ }).locator("[data-calc-value]")).toHaveAttribute("data-calc-value", "partial");
  await expect(inDone.getByRole("rowheader")).toHaveText(`Count≥ ${done}`);
  // Collapsed, the header says the same.
  const region = page.getByRole("region", { name: "done", exact: true });
  await region.getByRole("button", { name: "Collapse done" }).click();
  await expect(region.locator(".db-group-head")).toContainText("Count of Status: not counted");
});

test("grouped by a multi-value property: a row that repeats a value is one row of that group", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?dupe");
  await choose(page, "Estimate (h)", "Sum");
  await page.getByRole("button", { name: "View settings" }).click();
  await settings(page).getByLabel("Group by").selectOption("labels");
  await page.keyboard.press("Escape");
  const rows = (await rowsOf(page)).filter((n) => Array.isArray(n.metadata.labels) && n.metadata.labels.includes("launch"));
  const launch = page.getByRole("region", { name: "launch", exact: true });
  await expect(launch.locator("tbody tr[data-row-id]")).toHaveCount(rows.length);
  await expect(launch.locator('tbody tr[data-row-id="dup1"]')).toHaveCount(1);
  await expect(launch.locator("tfoot").getByRole("rowheader")).toHaveText(`Count${rows.length}`);
  await expect(launch.locator("tfoot").getByRole("button", { name: `Sum of Estimate (h): ${sum(rows, "estimate")} in launch`, exact: true })).toBeVisible();
});
