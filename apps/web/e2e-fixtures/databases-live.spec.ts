/**
 * Databases against the REAL Prism Server fixture (gateway + query route + listing cache over the
 * fake vault). The other database specs run on an in-memory client with no server cache, which is
 * where the stale listing hid: this spec fails without the cache being dropped on a vault change.
 * The cell edits below exercise the real property route; the "shown at once" guarantee itself is
 * proven with a slow refetch in databases.spec.ts (a local server answers too fast to show it).
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL)); });
test.afterAll(async () => server?.stop());

const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });

test("live: a new row is in the table at once, and a cell edited twice in a row is not a conflict", async ({ page, context }) => {
  const tag = `livedb${Date.now().toString(36)}`;
  const db = `db-${tag}`;
  expect(await server.add({ id: db, path: `Live ${tag}`, tags: [], metadata: { prism_type: "database", title: `Live ${tag}`, prism_database: { version: 1, source: { tags: [tag] }, views: [{ id: "table", name: "All rows", type: "table" }] } } })).toBe(true);
  for (const [id, title, flagged] of [["a", "First row", false], ["b", "Second row", true]] as const)
    expect(await server.add({ id: `${tag}-${id}`, path: `Live ${tag}/${title}`, tags: [tag], metadata: { title, flagged } })).toBe(true);
  await connect(page, context, server, "owner");
  await page.goto(`/e2e-fixtures/collab-route.html?page=${db}`);
  const table = page.getByRole("table", { name: "All rows" });
  await expect(row(page, "First row")).toBeVisible();
  await expect(row(page, "Second row")).toBeVisible();

  // The page routes create the row; the query route's listing cache must not serve the list from before it.
  await table.getByRole("button", { name: "New", exact: true }).click();
  const name = page.getByRole("textbox", { name: "New page title" });
  await name.fill("Made just now");
  await name.press("Enter");
  await expect(row(page, "Made just now")).toBeVisible({ timeout: 3000 });

  // Two edits of one cell, faster than the rows are read again.
  const flagged = row(page, "First row").getByRole("checkbox", { name: /flagged/i });
  await expect(flagged).not.toBeChecked();
  await flagged.click();
  await expect(flagged).toBeChecked();
  await flagged.click();
  await expect(flagged).not.toBeChecked();
  await expect(page.getByText(/Changed elsewhere/)).toHaveCount(0);
  await expect.poll(async () => (await server.note(`${tag}-a`))?.metadata?.flagged).toBe(false);
});
