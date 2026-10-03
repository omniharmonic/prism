import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/** Notion parity — CSV import (owner/admin, mapping + dry-run preview) and export (NP-DB-25). */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);

const CSV = [
  "Name,Status,Priority,Estimate,Notes",
  "Write release notes,done,high,2,already here",
  "Plan the launch party,todo,low,4,",
  "Broken row,maybe,low,1,",
].join("\n");

test("csv import preview and export", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "More database actions" }).click();
  await page.getByRole("menuitem", { name: "Import CSV…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import CSV" });
  await dialog.getByLabel("CSV file").setInputFiles({ name: "launch.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });

  // Columns are mapped by name; unknown ones are skipped until mapped.
  const mapping = dialog.getByRole("table", { name: "Column mapping" });
  await expect(mapping.getByLabel("Map Name")).toHaveValue("$title");
  await expect(mapping.getByLabel("Map Status")).toHaveValue("status");
  await expect(mapping.getByLabel("Map Priority")).toHaveValue("priority");
  await expect(mapping.getByLabel("Map Notes")).toHaveValue("");
  await mapping.getByLabel("Map Estimate").selectOption("estimate");
  await expect(dialog.getByLabel("Key column")).toHaveValue("Name");

  // Preview = a dry run; nothing is written.
  await dialog.getByRole("button", { name: "Preview import" }).click();
  const preview = dialog.getByRole("status", { name: "Import preview" });
  await expect(preview).toContainText("1 new, 1 updated, 0 unchanged, 1 with problems");
  await expect(preview).toContainText("Row 2: Update Write release notes — status");
  await expect(preview).toContainText("Row 4: Status: “maybe” is not an option");
  let f = await fx(page);
  expect(f.imports.at(-1)).toMatchObject({ tag: "task", dryRun: true, keyColumn: "Name", pathPrefix: "Projects/Launch plan", mapping: { Name: "$title", Status: "status", Priority: "priority", Estimate: "estimate", Notes: "" } });
  expect(f.creates).toEqual([]);

  await dialog.getByRole("button", { name: "Import 2 rows" }).click();
  await expect(dialog.getByRole("status")).toContainText("Import finished. Created 1, updated 1.");
  f = await fx(page);
  expect(f.creates.at(-1)).toMatchObject({ path: "Projects/Launch plan/Plan the launch party", tags: ["task"], metadata: { title: "Plan the launch party", status: "todo", priority: "low", estimate: 4 } });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Plan the launch party", exact: true })).toBeVisible();

  // Export: the current view (filtered), its visible columns, formula-safe.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("priority");
  await filter.getByLabel("Filter value").selectOption("low");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More database actions" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export this view as CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Launch plan - All tasks.csv");
  const path = info.outputPath("export.csv");
  await file.saveAs(path);
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines = text.trim().split("\r\n");
  expect(lines[0]).toBe("Title,Status,Priority,Due,Assignee,Estimate (h),Labels,Flagged,Link");
  expect(lines.slice(1).map((l) => l.split(",")[0]).sort()).toEqual(["Plan the launch party", "Private planning note", "Update pricing page"]);
  await expect(page.locator(".db-toast")).toContainText("Exported 3 rows to CSV.");
});

test("csv import is offered only to people who can change the schema", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await page.getByRole("button", { name: "More database actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Export this view as CSV" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Import CSV…" })).toHaveCount(0);
});

// NP-DB-25 — a CSV becomes a NEW database: properties are created from the columns (types checked in a preview that
// writes nothing), then the rows are imported through the same owner route.
const BOOKS = [
  "Title,Author,Pages,Finished,Genre,Link",
  "Braiding Sweetgrass,Robin Wall Kimmerer,408,yes,nature,https://example.test/a",
  "The Overstory,Richard Powers,502,no,fiction,https://example.test/b",
  "Entangled Life,Merlin Sheldrake,368,yes,nature,https://example.test/c",
  "Pilgrim at Tinker Creek,Annie Dillard,304,yes,nature,https://example.test/d",
  "Bad row,Someone,many,no,fiction,https://example.test/e",
].join("\n");

test("csv import into a new database", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByRole("button", { name: "Page", exact: true }).click();
  await create.getByRole("button", { name: "Database", exact: true }).click();
  await create.getByRole("textbox").first().fill("Reading list");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Or import a CSV as its rows…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import CSV as a new database" });
  await dialog.getByLabel("CSV file").setInputFiles({ name: "reading-list.csv", mimeType: "text/csv", buffer: Buffer.from(BOOKS) });

  // Column types are guessed from the values and can be changed.
  const cols = dialog.getByRole("table", { name: "Columns" });
  await expect(cols.getByLabel("Column Title")).toHaveValue("title");
  await expect(cols.getByLabel("Column Author")).toHaveValue("text");
  await expect(cols.getByLabel("Column Pages")).toHaveValue("text"); // "many" is not a number
  await expect(cols.getByLabel("Column Finished")).toHaveValue("checkbox");
  await expect(cols.getByLabel("Column Genre")).toHaveValue("select");
  await expect(cols.getByLabel("Column Link")).toHaveValue("url");
  await cols.getByLabel("Column Pages").selectOption("number");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("reading-list");

  // A tag that already has pages is refused: its rows belong to its own database.
  await dialog.getByLabel("Tag for its pages").fill("task");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("#task is already in use by 7 pages");
  await dialog.getByLabel("Tag for its pages").fill("book");
  await dialog.getByRole("button", { name: "Preview" }).click();
  const preview = dialog.getByRole("status", { name: "Import preview" });
  await expect(preview).toContainText("a new database “Reading list” with 5 properties, and 4 of 5 rows as pages tagged #book; 1 row has a value that does not fit its column and will be skipped.");
  await expect(preview).toContainText("Row 6, Pages: “many” is not a number");
  // The preview wrote nothing.
  let f = await fx(page);
  expect(f.schemaWrites).toEqual([]);
  expect(f.imports).toEqual([]);
  expect(f.creates.length).toBe(1); // only the empty database page itself

  await dialog.getByRole("button", { name: "Create database and import 4 rows" }).click();
  await expect(dialog.getByRole("status")).toContainText("“Reading list” is ready. Created 4 pages with 5 properties.");
  await expect(dialog).toContainText("Skipped rows: row 6");
  f = await fx(page);
  expect(f.schemaWrites).toEqual([{ tag: "book", patch: {
    fields: { author: { type: "string" }, pages: { type: "number" }, finished: { type: "boolean" }, genre: { type: "string", enum: ["nature", "fiction"] }, link: { type: "string" } },
    ui: { author: { kind: "text", label: "Author" }, pages: { kind: "number", label: "Pages" }, finished: { kind: "checkbox", label: "Finished" }, genre: { kind: "select", label: "Genre" }, link: { kind: "url", label: "Link" } },
  } }]);
  expect(f.imports.at(-1)).toMatchObject({ tag: "book", dryRun: false, pathPrefix: "Projects/Reading list", mapping: { Title: "$title", Author: "author", Pages: "pages", Finished: "finished", Genre: "genre", Link: "link" } });
  const config = f.writes.find((w: any) => w.metadata?.prism_database);
  expect(config.metadata.prism_database).toEqual({ version: 1, source: { tags: ["book"] }, views: [{ id: "table", name: "Table", type: "table", visible: ["author", "pages", "finished", "genre", "link"] }] });
  expect(config.ifUpdatedAt).toBeTruthy(); // compare-and-set on the database page
  await dialog.getByRole("button", { name: "Done" }).click();

  // The page is now a Table over #book with typed cells.
  const table = page.getByRole("table", { name: "Table" });
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(4);
  await expect(table.locator("thead th")).toHaveText(["Title", "Author", "Pages", "Finished", "Genre", "Link"]);
  const sweet = page.locator("tr", { has: page.getByRole("button", { name: "Braiding Sweetgrass", exact: true }) });
  await expect(sweet.getByRole("button", { name: "Pages: 408" })).toBeVisible();
  await expect(sweet.getByRole("checkbox", { name: "Finished" })).toBeChecked();
  await expect(sweet.locator('.db-opt[data-value="nature"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Bad row", exact: true })).toHaveCount(0);
});

test("csv into a new database is offered only to people who can change schemas", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page&viewer");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByRole("button", { name: "Page", exact: true }).click();
  await create.getByRole("button", { name: "Database", exact: true }).click();
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Which pages should this database show?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Or import a CSV as its rows…" })).toHaveCount(0);
});
