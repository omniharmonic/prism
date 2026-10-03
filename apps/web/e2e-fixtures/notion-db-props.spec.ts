import { test, expect, type Page } from "@playwright/test";

/** Notion parity — further property types, system properties, relations (NP-DB-09/10/12). Fixture: databases.html. */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
/** Property writes (view-config saves to the database note excluded). */
const writes = async (page: Page) => ((await fx(page)).writes as any[]).filter((w: any) => !w.metadata?.prism_database);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });

async function showColumns(page: Page, labels: string[]) {
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  for (const l of labels) await settings.getByRole("list", { name: "Visible properties" }).getByRole("checkbox", { name: l, exact: true }).check();
  await page.keyboard.press("Escape");
}

test("email, phone, files properties", async ({ page }) => {
  await page.route("**/api/attachments/*", (r) => r.fulfill({ path: "e2e-fixtures/media/cover.png" }));
  await page.goto("/e2e-fixtures/databases.html");
  await showColumns(page, ["Email", "Phone", "Files"]);
  const r = row(page, "Refine onboarding copy");

  await r.getByRole("button", { name: "Email: Empty" }).click();
  const email = page.getByRole("textbox", { name: "Email" });
  await expect(email).toHaveAttribute("type", "email");
  await email.fill("not an address");
  await email.press("Enter");
  await expect(r.getByRole("alert")).toContainText("doesn’t look like an email address");
  expect((await writes(page)).length).toBe(0);
  await email.fill("ada@example.test");
  await email.press("Enter");
  await expect(r.getByRole("link", { name: "ada@example.test" })).toHaveAttribute("href", "mailto:ada@example.test");
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { email: "ada@example.test" }, expect: { email: null } });

  await r.getByRole("button", { name: "Phone: Empty" }).click();
  const phone = page.getByRole("textbox", { name: "Phone" });
  await expect(phone).toHaveAttribute("type", "tel");
  await phone.fill("+1 (555) 010-2030");
  await phone.press("Enter");
  await expect(r.getByRole("link", { name: "+1 (555) 010-2030" })).toHaveAttribute("href", "tel:+15550102030");
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { phone: "+1 (555) 010-2030" }, expect: { phone: null } });

  // Files & media: upload attaches to the ROW's page; the value is a list of named links to our attachments.
  await r.getByRole("button", { name: "Files: Empty" }).click();
  const files = page.getByRole("dialog", { name: "Files files" });
  await expect(files).toContainText("No files yet.");
  await files.locator('input[type="file"]').setInputFiles([
    { name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
    { name: "mock [v2].png", mimeType: "image/png", buffer: Buffer.from("png") },
  ]);
  await expect(files.getByRole("listitem")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).dbUploads)).toEqual([{ noteId: "t3", name: "brief.pdf", kind: "file" }, { noteId: "t3", name: "mock [v2].png", kind: "file" }]);
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { files: ["[brief.pdf](/api/attachments/a_up1)", "[mock  v2 .png](/api/attachments/a_up2)"] }, expect: { files: null } });
  // Image files preview as a thumbnail; any file downloads on click.
  await expect(files.locator("img.db-file-thumb")).toHaveAttribute("src", "/api/attachments/a_up2");
  const download = page.waitForEvent("download");
  await files.getByRole("button", { name: "brief.pdf", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("brief.pdf");
  // Remove one.
  await files.getByRole("button", { name: "Remove brief.pdf" }).click();
  await expect(files.getByRole("listitem")).toHaveCount(1);
  expect((await writes(page)).at(-1).set).toEqual({ files: ["[mock  v2 .png](/api/attachments/a_up2)"] });
  await page.keyboard.press("Escape");
  await expect(r.locator(".db-file")).toHaveCount(1);

  // Both filter like text.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("email");
  await filter.getByLabel("Condition 1 operator").selectOption("exists");
  await expect(page.getByRole("table", { name: "All tasks" }).locator("tbody tr[data-row-id]")).toHaveCount(1);
});

test("system properties sort and filter", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await showColumns(page, ["Created time", "Last edited time", "Created by", "Last edited by"]);
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: "Created time", exact: true })).toBeVisible();
  const r1 = row(page, "Review workspace navigation");
  await expect(r1.getByRole("button", { name: /^Created by: mira@example\.test/ })).toBeVisible();
  await expect(r1.getByRole("button", { name: /^Last edited by: sam@example\.test/ })).toBeVisible();
  // The stamp keys are fetched only because the view shows them.
  const fields = (await fx(page)).queries.at(-1).fields;
  expect(fields).toEqual(expect.arrayContaining(["prism_creator", "prism_last_writer"]));

  // Read-only: clicking a system cell opens no editor and writes nothing.
  await r1.getByRole("button", { name: /^Last edited by:/ }).click();
  await expect(page.getByRole("textbox", { name: "Last edited by" })).toHaveCount(0);

  // Sortable from the header…
  await table.getByRole("button", { name: "Created time", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect(table.locator("tbody tr[data-row-id]").first()).toContainText("Review workspace navigation");
  await table.getByRole("button", { name: "Last edited time", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect(table.locator("tbody tr[data-row-id]").first()).toContainText("Review workspace navigation");

  // …and filterable.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("prism_last_writer");
  await filter.getByLabel("Filter value").fill("mira");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(row(page, "Write release notes")).toBeVisible();
  await filter.getByLabel("Condition 1 property").selectOption("$createdAt");
  await filter.getByLabel("Condition 1 operator").selectOption("lt");
  await filter.getByLabel("Filter value").fill("2026-09-30");
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(2);
  expect(await writes(page)).toEqual([]);
});

test("relation picker and reverse property", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=t3");
  const bar = page.getByRole("group", { name: "Page properties" });
  await bar.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name: /Project/ }).click();
  // The picker searches the TARGET database (#initiative), not the whole vault.
  const picker = page.getByRole("dialog", { name: "Link Project" });
  await expect(picker.getByRole("option", { name: /Atlas/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Mira Chen/ })).toHaveCount(0);
  await picker.getByRole("textbox", { name: "Search pages" }).fill("bea");
  await picker.getByRole("option", { name: /Beacon/ }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { project: "[[Projects/Beacon]]" }, expect: { project: null } });
  await expect(bar.getByRole("button", { name: "Project: Beacon" })).toBeVisible();
  const q = (await fx(page)).queries.find((s: any) => s.tags[0] === "initiative");
  expect(q).toBeTruthy();

  // The target page shows who links to it (read-only, computed; never written back).
  await page.goto("/e2e-fixtures/databases.html?open=atlas");
  const tasks = page.getByRole("list", { name: "Tasks" });
  await expect(tasks.getByRole("listitem")).toHaveCount(2);
  await expect(tasks.getByRole("button", { name: "Review workspace navigation" })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Write release notes" })).toBeVisible();
  const reverse = (await fx(page)).queries.find((s: any) => s.filter?.conditions?.[0]?.key === "project");
  expect(reverse).toMatchObject({ tags: ["task"], filter: { match: "all", conditions: [{ key: "project", op: "eq", value: "Projects/Atlas" }] } });
  await tasks.getByRole("button", { name: "Write release notes" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId))).toContain("t2");
  expect((await writes(page)).length).toBe(0);
});

test("a saved view change never shows the previous config again", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("columnheader").first()).toBeVisible();
  // Count every time the Email column disappears after it was shown: dropping the
  // optimistic config before the note prop caught up reverted the view for a tick
  // (checkboxes flickered back; a click in that tick undid the saved change).
  await page.evaluate(() => {
    const w = window as any; w.columnReverts = 0; let seen = false;
    new MutationObserver(() => {
      const has = [...document.querySelectorAll("[role=columnheader], th")].some((h) => /\bEmail\b/.test(h.textContent ?? ""));
      if (seen && !has) w.columnReverts += 1;
      seen = has;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await showColumns(page, ["Email"]);
  await expect(page.getByRole("columnheader", { name: /Email/ })).toBeVisible();
  await expect.poll(async () => ((await fx(page)).writes as any[]).filter((w: any) => w.metadata?.prism_database).length).toBe(1);
  // Let the save settle: timers queued before this one (the query cache's notification) run first, then a frame.
  await page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 0)));
  await expect(page.getByRole("columnheader", { name: /Email/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).columnReverts)).toBe(0);
});

// NP-DB-11 / NP-DB-08 — property management from a table header: retype with a preview over the loaded rows, number format,
// and delete with "remove the values" (dry run first, then the owner job).
test("property management from the table: retype preview, number format, delete and remove values", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=db2");
  const table = page.getByRole("table", { name: "All initiatives" });
  const notes = () => page.evaluate(() => (window as any).dbFixture.notes() as any[]);
  await expect(row(page, "Atlas").getByRole("button", { name: "Stage: active" })).toBeVisible();
  const edit = async (label: string) => {
    await table.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit property…" }).click();
    return page.getByRole("dialog", { name: `Edit property ${label}` });
  };

  // Text → URL: the preview says how many current values will not read as links.
  let editor = await edit("Stage");
  await editor.getByLabel("Property type").selectOption("url");
  const preview = editor.getByRole("group", { name: "Type change preview" });
  await expect(preview).toContainText("0 of 2 values will show as URL; 2 do not look like one and will show as plain text.");
  await preview.getByRole("button", { name: "Cancel" }).click();
  // Text → Select: every value fits; cells become chips; stored values untouched.
  await editor.getByLabel("Property type").selectOption("select");
  await expect(preview).toContainText("2 of 2 values will show as Select.");
  await preview.getByRole("button", { name: "Change type to Select" }).click();
  await expect(row(page, "Atlas").locator('.db-opt[data-value="active"]')).toBeVisible();
  expect((await fx(page)).schemaWrites.at(-1)).toEqual({ tag: "initiative", patch: { ui: { stage: { kind: "select" } } } });
  await editor.getByRole("button", { name: "Close" }).click();

  // Number format is a display hint: the stored number is unchanged.
  editor = await edit("Budget");
  await editor.getByLabel("Number format").selectOption("usd");
  await expect(row(page, "Atlas").getByRole("button", { name: "Budget: $12,500.00" })).toBeVisible();
  await expect(row(page, "Beacon").getByRole("button", { name: "Budget: $800.50" })).toBeVisible();
  await editor.getByLabel("Number format").selectOption("percent");
  await expect(row(page, "Atlas").getByRole("button", { name: "Budget: 12,500%" })).toBeVisible();
  expect((await notes()).find((n: any) => n.id === "atlas").metadata.budget).toBe(12500);
  // A number can never become text: the option is disabled and explained.
  await expect(editor.getByLabel("Property type").locator('option[value="text"]')).toHaveJSProperty("disabled", true);
  await editor.getByRole("button", { name: "Close" }).click();
  // Editing the formatted number still edits the raw value.
  await row(page, "Atlas").getByRole("button", { name: "Budget: 12,500%" }).click();
  await expect(page.getByRole("textbox", { name: "Budget" })).toHaveValue("12500");
  await page.keyboard.press("Escape");

  // Delete + remove the values: a dry run names the count, then the job runs.
  editor = await edit("Stage");
  await editor.getByRole("button", { name: "Delete property…" }).click();
  const del = editor.getByRole("group", { name: "Delete property" });
  await del.getByRole("radio", { name: /Remove the values from every page/ }).check();
  await del.getByRole("button", { name: "Check what would be removed" }).click();
  await expect(del.getByRole("status")).toContainText("2 pages hold a “Stage” value.");
  expect((await fx(page)).removals).toEqual([{ tag: "initiative", field: "stage", dryRun: true }]);
  expect((await notes()).find((n: any) => n.id === "atlas").metadata.stage).toBe("active"); // nothing yet
  await del.getByRole("button", { name: "Delete and remove 2 values" }).click();
  await expect(editor.getByRole("status")).toContainText("Removed the value from 2 pages.");
  expect((await fx(page)).removals.at(-1)).toEqual({ tag: "initiative", field: "stage", dryRun: false });
  const after = (await notes()).filter((n: any) => n.tags.includes("initiative"));
  expect(after.map((n: any) => "stage" in n.metadata)).toEqual([false, false]);
  expect(after.map((n: any) => n.metadata.budget)).toEqual([12500, 800.5]); // other properties stay
  await editor.getByRole("button", { name: "Close" }).click();
  await expect(table.getByRole("button", { name: "Stage", exact: true })).toHaveCount(0);
  // The filter builder no longer offers it either.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("dialog", { name: "Filter" }).getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByLabel("Condition 1 property").locator("option", { hasText: "Stage" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Filter" }).getByRole("button", { name: "Clear all" }).click();
  await page.keyboard.press("Escape");
  // It can be restored from View settings (the column comes back, now empty).
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByRole("button", { name: "Manage deleted property Stage" }).click();
  await page.getByRole("dialog", { name: "Edit property Stage" }).getByRole("button", { name: "Restore property" }).click();
  await expect(table.getByRole("button", { name: "Stage", exact: true })).toBeVisible();
  await expect(row(page, "Atlas").getByRole("button", { name: "Stage: Empty" })).toBeVisible();
});
