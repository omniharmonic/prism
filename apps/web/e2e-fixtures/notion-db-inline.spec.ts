import { test, expect, type Page } from "@playwright/test";

/**
 * Notion parity — inline and linked database blocks (NP-DB-02). Fixture:
 * databases.html?block renders a page whose body holds the editor's stored
 * block HTML (`<div data-prism-database="db" data-view="board">`) parsed with
 * `parseDatabaseBlock` and rendered with `renderDatabaseBlock` — exactly what
 * the editor's `databaseView` atom NodeView does.
 */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const configWrites = async (page: Page) => ((await fx(page)).writes as any[]).filter((w: any) => w.metadata?.prism_database);

test("inline linked board inside a page", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?block");
  const doc = page.getByRole("article", { name: "Launch brief" });
  await expect(doc.getByRole("heading", { name: "Launch brief" })).toBeVisible();
  const blocks = doc.locator(".db-block");
  await expect(blocks).toHaveCount(2);

  // Block 1: the linked BOARD view of the Launch plan database.
  const board = blocks.nth(0);
  await expect(board.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  const col = board.getByRole("list", { name: "Board board" });
  await expect(col.getByRole("region", { name: "in-progress" }).getByRole("article", { name: "Write release notes" })).toBeVisible();
  // Moving a card writes the row's property (the same per-field CAS as the database page).
  await board.getByRole("button", { name: "Actions for Refine onboarding copy" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "done" }).click();
  await expect(col.getByRole("region", { name: "done" }).getByRole("article", { name: "Refine onboarding copy" })).toBeVisible();
  expect((await fx(page)).writes.at(-1)).toEqual({ id: "t3", set: { status: "done" }, expect: { status: "in-progress" } });

  // Block 2: the TABLE view of the same database, with its own filter saved to that view.
  const tableBlock = blocks.nth(1);
  const table = tableBlock.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: "Refine onboarding copy", exact: true })).toBeVisible();
  await tableBlock.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("priority");
  await filter.getByLabel("Filter value").selectOption("high");
  await page.keyboard.press("Escape");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(2);
  const views = (await configWrites(page)).at(-1).metadata.prism_database.views;
  expect(views.find((v: any) => v.id === "table").filter).toEqual({ match: "all", conditions: [{ key: "priority", op: "eq", value: "high" }] });
  expect(views.find((v: any) => v.id === "board").filter).toBeUndefined();
  // The board block is untouched by the table block's filter.
  await expect(col.getByRole("article")).toHaveCount(7);

  // A row opens in a peek over the page; the block's title opens the database.
  await table.getByRole("button", { name: "Write release notes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Write release notes (side peek)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tableBlock.getByRole("button", { name: /^Launch plan/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toContain("db");

  // A block pointing at something you cannot see says so — nothing about it leaks.
  await expect(doc.getByText("This database is unavailable. It may have moved, or you may not have access.")).toBeVisible();
});

test("inline database: phone width keeps the page inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html?block");
  await expect(page.locator(".db-block").first().getByRole("tab", { name: "Board" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// NP-DB-01 — slash "Database – full page": a new database as a sub-page, linked from the page (never embedded).
test("slash: full-page database creates a sub-page and leaves a link", async ({ page }) => {
  await page.goto(`/e2e-fixtures/notion-media.html?content=${encodeURIComponent("<p>Plan</p><p></p>")}`);
  await page.locator(".tiptap p").nth(1).click();
  await page.keyboard.type("/full");
  await expect(page.getByRole("option", { name: /^Full-page database/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New full-page database" });
  await dialog.getByRole("textbox").fill("book");
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  const created = await page.evaluate(() => (window as any).prismMediaCreates[0]);
  expect(created.path).toBe("Projects/Prism/Field guide/book database");
  expect(created.metadata.prism_type).toBe("database");
  expect(created.metadata.prism_database.views).toHaveLength(1);
  expect(created.metadata.prism_database.views[0].type).toBe("table");
  const stored = await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
  expect(stored).toContain("[[Projects/Prism/Field guide/book database]]");
  expect(stored).not.toContain("data-prism-database"); // a link to the page, not an inline block
});
