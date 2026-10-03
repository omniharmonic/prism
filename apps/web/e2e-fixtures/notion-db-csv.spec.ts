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
