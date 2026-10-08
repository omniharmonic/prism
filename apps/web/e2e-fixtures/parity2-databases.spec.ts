import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 2 — database clauses that existed in the product but had no assertion
 * (NP-DB-03 frozen column + row count, NP-DB-05/06 chosen properties, NP-DB-13 operators per type).
 */
const writes = (page: Page) => page.evaluate(() => (window as any).dbFixture.writes as any[]);
const configWrites = async (page: Page) => (await writes(page)).filter((w: any) => w.metadata?.prism_database);

/** NP-DB-13: the operators offered are the ones that make sense for the property's type. */
test("filter operators follow the property type", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table).toBeVisible();
  const all = await table.locator("tbody tr[data-row-id]").count();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  const property = filter.getByLabel("Condition 1 property");
  const operator = filter.getByLabel("Condition 1 operator");
  const ops = () => operator.locator("option").allTextContents();

  await property.selectOption("priority"); // select
  expect(await ops()).toEqual(["is", "is not", "is not empty", "is empty"]);
  await property.selectOption("status"); // status
  expect(await ops()).toEqual(["is", "is not", "is not empty", "is empty"]);
  await property.selectOption("estimate"); // number
  expect(await ops()).toEqual(["is", "is not", "is after / above", "is on or after", "is before / below", "is on or before", "is not empty", "is empty"]);
  await property.selectOption("flagged"); // checkbox
  expect(await ops()).toEqual(["is"]);
  await property.selectOption("labels"); // multi-select
  const labels = await ops();
  expect(labels).toContain("contains");
  expect(labels).toContain("does not contain");
  expect(labels).toContain("is empty");
  expect(labels).not.toContain("is after / above");
  await property.selectOption("link"); // URL / text
  const link = await ops();
  expect(link).toContain("contains");
  expect(link).toContain("is not");
  expect(link).not.toContain("is on or after");

  // "is empty" on a number narrows the rows and is what the view saves.
  await property.selectOption("estimate");
  await operator.selectOption("not_exists");
  await expect.poll(() => table.locator("tbody tr[data-row-id]").count()).toBeLessThan(all);
  const withoutEstimate = await table.locator("tbody tr[data-row-id]").count();
  await operator.selectOption("exists");
  await expect.poll(() => table.locator("tbody tr[data-row-id]").count()).toBe(all - withoutEstimate);
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views[0].filter?.conditions?.[0]).toMatchObject({ key: "estimate", op: "exists" });
});

/** NP-DB-03: the title column stays in place while the other columns scroll, and the view says how many rows it has. */
test("table: the first column stays frozen on a wide table and the row count shows", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  const first = table.getByRole("button", { name: "Review workspace navigation", exact: true });
  await expect(first).toBeVisible();
  const rows = await table.locator("tbody tr[data-row-id]").count();
  await expect(table.locator("tfoot").getByRole("rowheader")).toHaveAccessibleName(`Count: ${rows}`);
  const wrap = page.locator(".db-table-wrap").first();
  expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true); // wider than the screen
  const header = page.getByRole("button", { name: "Priority", exact: true });
  const titleBefore = (await first.boundingBox())!.x;
  const headerBefore = (await header.boundingBox())!.x;
  await wrap.evaluate((el) => { el.scrollLeft = 300; });
  await expect.poll(async () => (await header.boundingBox())!.x).toBeLessThan(headerBefore - 200);
  expect((await first.boundingBox())!.x).toBe(titleBefore);
  // The page itself never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** NP-DB-05 / NP-DB-06: list rows and gallery cards show the properties chosen for THAT view. */
test("list rows and gallery cards show the view's chosen properties", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  // List: status + due are chosen; priority is not.
  await page.getByRole("tab", { name: "List" }).click();
  const list = page.getByRole("list", { name: "List list" });
  const item = list.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Design new icon set", exact: true }) });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Done");
  await expect(item).not.toContainText("Medium");
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  await settings.getByRole("list", { name: "Visible properties" }).getByRole("checkbox", { name: "Priority", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(item).toContainText("Medium");
  await expect.poll(async () => (await configWrites(page)).at(-1)?.metadata.prism_database.views.find((v: any) => v.id === "list").visible).toContain("priority");
  // Gallery: its own choice (status + priority), unaffected by the list's.
  await page.getByRole("tab", { name: "Gallery" }).click();
  const card = page.getByRole("list", { name: "Gallery gallery" }).getByRole("listitem", { name: "Design new icon set" });
  await expect(card).toContainText("Done");
  await expect(card).toContainText("Medium");
  expect((await configWrites(page)).at(-1).metadata.prism_database.views.find((v: any) => v.id === "gallery").visible).toEqual(["status", "priority"]);
});
