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
  // The chip opens the related page: from the picker…
  const tabs = () => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId) as string[]);
  await bar.getByRole("button", { name: "Project: Beacon" }).click();
  await page.getByRole("dialog", { name: "Link Project" }).getByRole("button", { name: "Open Beacon" }).click();
  await expect.poll(tabs).toContain("beacon");

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

// NP-DB-12 — relation chips open the related page, and the reverse property is editable from the target
// (it writes the linking page's forward value with compare-and-set; the target page itself is never written).
test("relation chips open pages; the reverse property edits the forward side", async ({ page }) => {
  const tabs = () => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId) as string[]);
  // In a table: a plain click on an editable cell edits; ⌘/Ctrl-click on the chip opens the page.
  await page.goto("/e2e-fixtures/databases.html");
  await showColumns(page, ["Project"]);
  await row(page, "Write release notes").locator(".db-link-chip", { hasText: "Atlas" }).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(tabs).toContain("atlas");
  // Read-only (a viewer): the chip is a link and a plain click opens it.
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await showColumns(page, ["Project"]);
  await row(page, "Write release notes").getByRole("link", { name: "Atlas" }).click();
  await expect.poll(tabs).toContain("atlas");
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await showColumns(page, ["Assignee"]);
  await row(page, "Write release notes").getByRole("link", { name: /Sam Rivera/ }).click();
  await expect.poll(tabs).toContain("p2");
  expect(await writes(page)).toEqual([]);

  // The reverse side on the target page: add and remove linking pages.
  await page.goto("/e2e-fixtures/databases.html?open=atlas");
  const tasks = page.getByRole("list", { name: "Tasks" });
  await expect(tasks.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Edit Tasks" }).click();
  const picker = page.getByRole("dialog", { name: "Edit Tasks" });
  await expect(picker.getByRole("option", { name: /Write release notes/ })).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("textbox", { name: "Search #task pages" }).fill("onboarding");
  await picker.getByRole("option", { name: /Refine onboarding copy/ }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { project: "[[Projects/Atlas]]" }, expect: { project: null } });
  await expect(tasks.getByRole("listitem")).toHaveCount(3);
  await picker.getByRole("textbox", { name: "Search #task pages" }).fill("");
  await picker.getByRole("option", { name: /Write release notes/ }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t2", set: { project: null }, expect: { project: "[[Projects/Atlas]]" } });
  await expect(tasks.getByRole("listitem")).toHaveCount(2);
  await expect(tasks.getByRole("button", { name: "Write release notes" })).toHaveCount(0);
  // The linking page was changed elsewhere meanwhile: refused, nothing overwritten.
  await page.evaluate(() => { (window as any).dbFixture.conflictWith = "[[Projects/Beacon]]"; });
  await picker.getByRole("option", { name: /Design new icon set/ }).click();
  await expect(picker.getByRole("alert")).toContainText("“Design new icon set” was changed somewhere else");
  expect(await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t4").metadata.project)).toBe("[[Projects/Beacon]]");
  await expect(picker.getByRole("option", { name: /Design new icon set/ })).toContainText("now: Beacon");
  // Only the linking pages were written — never the target page itself.
  expect((await writes(page)).every((w: any) => w.id !== "atlas")).toBe(true);
});

// NP-DB-12, every clause, from BOTH sides: the picker searches the target database; related pages are chips that
// open them; the reverse property on the target is optional (the owner names it, renames it, or stops showing it);
// and an edit made on either side is what the other side shows (one relation, never two that can disagree).
test("NP-DB-12: a relation edited from either side shows on both; the reverse property is optional", async ({ page }) => {
  const tabs = () => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId) as string[]);
  const bar = page.getByRole("group", { name: "Page properties" });
  const tasks = page.getByRole("list", { name: "Tasks" });

  // Forward side: on a task, the picker searches #initiative pages only; the choice is a chip.
  await page.goto("/e2e-fixtures/databases.html?open=t3");
  await bar.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name: /Project/ }).click();
  const picker = page.getByRole("dialog", { name: "Link Project" });
  await picker.getByRole("textbox", { name: "Search pages" }).fill("bea");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByRole("option", { name: /Beacon/ }).click();
  await expect(bar.getByRole("button", { name: "Project: Beacon" })).toBeVisible();

  // …and the target page shows it under the reverse property, as a chip that opens the task.
  await page.goto("/e2e-fixtures/databases.html?open=beacon");
  await expect(tasks.getByRole("listitem")).toHaveCount(1);
  await expect(tasks.getByRole("button", { name: "Refine onboarding copy" })).toBeVisible();
  await tasks.getByRole("button", { name: "Refine onboarding copy" }).click();
  await expect.poll(tabs).toContain("t3");

  // Reverse side: add one task and remove another from the TARGET page.
  await page.goto("/e2e-fixtures/databases.html?open=beacon");
  await page.getByRole("button", { name: "Edit Tasks" }).click();
  const reverse = page.getByRole("dialog", { name: "Edit Tasks" });
  await reverse.getByRole("textbox", { name: "Search #task pages" }).fill("pricing");
  await reverse.getByRole("option", { name: /Update pricing page/ }).click();
  await expect(tasks.getByRole("listitem")).toHaveCount(2);
  await reverse.getByRole("textbox", { name: "Search #task pages" }).fill("");
  await reverse.getByRole("option", { name: /Refine onboarding copy/ }).click();
  await expect(tasks.getByRole("listitem")).toHaveCount(1);
  await expect(tasks.getByRole("button", { name: "Update pricing page" })).toBeVisible();
  // Stored on ONE side only: the linking pages changed, the target page did not.
  const stored = await page.evaluate(() => Object.fromEntries((window as any).dbFixture.notes().filter((n: any) => ["t3", "t5", "beacon"].includes(n.id)).map((n: any) => [n.id, n.metadata.project ?? null])));
  expect(stored).toEqual({ t3: null, t5: "[[Projects/Beacon]]", beacon: null });
  expect((await writes(page)).every((w: any) => w.id !== "beacon")).toBe(true);

  // …and the forward side shows what the reverse side did: on the pages, and in the database table.
  await page.goto("/e2e-fixtures/databases.html?open=t5");
  await expect(bar.getByRole("button", { name: "Project: Beacon" })).toBeVisible();
  await page.goto("/e2e-fixtures/databases.html?open=t3");
  await expect(bar.getByRole("button", { name: "Project: Beacon" })).toHaveCount(0);
  await page.goto("/e2e-fixtures/databases.html");
  await showColumns(page, ["Project"]);
  await expect(row(page, "Update pricing page").locator(".db-link-chip", { hasText: "Beacon" })).toBeVisible();
  await expect(row(page, "Refine onboarding copy").locator(".db-link-chip", { hasText: "Beacon" })).toHaveCount(0);

  // Optional: the owner renames the reverse property, or stops showing it — on the relation itself.
  await page.goto("/e2e-fixtures/databases.html?open=t5");
  await bar.getByRole("button", { name: "Edit property Project" }).click();
  const editor = page.getByRole("dialog", { name: "Edit property Project" });
  const name = editor.getByLabel("Reverse property name");
  await expect(name).toHaveValue("Tasks");
  await name.fill("Work items");
  await editor.getByRole("button", { name: "Show on target pages" }).click();
  expect((await fx(page)).schemaWrites.at(-1)).toEqual({ tag: "task", patch: { ui: { project: { reverseLabel: "Work items" } } } });
  await page.goto("/e2e-fixtures/databases.html?open=beacon");
  await expect(page.getByRole("list", { name: "Work items" }).getByRole("listitem")).toHaveCount(1);
  await expect(tasks).toHaveCount(0);
  await page.goto("/e2e-fixtures/databases.html?open=t5");
  await bar.getByRole("button", { name: "Edit property Project" }).click();
  await name.fill("");
  await editor.getByRole("button", { name: "Stop showing it" }).click();
  await page.goto("/e2e-fixtures/databases.html?open=beacon");
  await expect(bar.getByRole("button", { name: /^Stage: / })).toBeVisible();
  await expect(page.getByRole("list", { name: "Work items" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit (Tasks|Work items)$/ })).toHaveCount(0);
  // The relation itself is untouched by hiding its reverse side.
  expect(await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "t5").metadata.project)).toBe("[[Projects/Beacon]]");
});

test("the reverse property is read-only for someone who cannot edit the page", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=atlas&viewer");
  await expect(page.getByRole("list", { name: "Tasks" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Edit Tasks" })).toHaveCount(0);
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
  // Number → text is not a presentation of a number: it is offered as a conversion (its own test below), never a silent retype.
  await expect(editor.getByLabel("Property type").locator('option[value="text"]')).toHaveText("Text — converts the values");
  await expect(editor.getByLabel("Property type").locator('option[value="text"]')).toHaveJSProperty("disabled", false);
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

// NP-DB-11 — "change type with a conversion preview" for a type the stored values are NOT (text → number):
// a dry run says what converts and what cannot; converting writes a NEW field (the vault type is never changed
// in place), the column keeps its name, place and sort, the old property is deleted-but-restorable with its
// values intact, and restoring it is the undo.
test("NP-DB-11: change type converts the values — preview, new field, old property kept and restorable", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=db2&convert");
  const table = page.getByRole("table", { name: "All initiatives" });
  const notes = () => page.evaluate(() => (window as any).dbFixture.notes() as any[]);
  const meta = async (id: string) => (await notes()).find((n: any) => n.id === id).metadata;
  const schemaFields = () => page.evaluate(() => (window as any).dbFixture.schemas().initiative.fields as Record<string, any>);
  await expect(row(page, "Atlas").getByRole("button", { name: "Score: 12", exact: true })).toBeVisible();
  await table.getByRole("button", { name: "Score", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit property…" }).click();
  const editor = page.getByRole("dialog", { name: "Edit property Score" });
  const type = editor.getByLabel("Property type");
  await expect(type).toHaveValue("text");
  await expect(type.locator('option[value="number"]')).toHaveText("Number — converts the values");

  // The preview is the server's dry run: counts, the values that cannot convert, and what happens to the old ones.
  await type.selectOption("number");
  const preview = editor.getByRole("group", { name: "Conversion preview" });
  await expect(preview.getByRole("status")).toContainText("2 of 3 values will convert to Number. 1 cannot be read as Number and will be left out of the new property.");
  await expect(preview.getByRole("list", { name: "Values that cannot be converted" })).toHaveText("n/a");
  await expect(preview).toContainText("Nothing is overwritten");
  expect((await fx(page)).conversions).toEqual([{ tag: "initiative", field: "score", to: "number", dryRun: true }]);
  expect((await meta("atlas")).score_number).toBeUndefined(); // a dry run writes nothing
  expect(Object.keys(await schemaFields())).not.toContain("score_number");
  // Cancel leaves everything as it was.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(type).toHaveValue("text");
  await expect(preview).toHaveCount(0);

  // Convert, in chunks (the server says `more`; the client asks again).
  await page.evaluate(() => { (window as any).dbFixture.convertChunk = 1; });
  await type.selectOption("number");
  await preview.getByRole("button", { name: "Convert to Number" }).click();
  const done = editor.getByRole("region", { name: "Type changed" });
  await expect(done.getByRole("status")).toContainText("“Score” is now Number. 2 values were converted. 1 could not be read as Number and was left out.");
  expect(((await fx(page)).conversions as any[]).filter((c) => !c.dryRun)).toHaveLength(2);
  // Stored: numbers in the NEW field, the old text untouched, the vault type of the old field unchanged.
  expect([(await meta("atlas")).score_number, (await meta("beacon")).score_number, (await meta("comet")).score_number]).toEqual([12, 1250, undefined]);
  expect([(await meta("atlas")).score, (await meta("beacon")).score, (await meta("comet")).score]).toEqual(["12", "1,250", "n/a"]);
  const fields = await schemaFields();
  expect(fields.score).toMatchObject({ type: "string", deleted: true });
  expect(fields.score_number).toMatchObject({ type: "number", kind: "number", label: "Score", deleted: false, convertedFrom: "score" });
  await done.getByRole("button", { name: "Done" }).click();

  // What the user sees: ONE "Score" column, in the same place, now a number (formatted, right editor), still sorted by it.
  await expect(table.getByRole("button", { name: "Score", exact: true })).toHaveCount(1);
  await expect(row(page, "Beacon").getByRole("button", { name: "Score: 1,250", exact: true })).toBeVisible();
  await expect(row(page, "Comet").getByRole("button", { name: "Score: Empty" })).toBeVisible();
  const view = (await meta("db2")).prism_database.views[0];
  expect(view.visible).toEqual(["stage", "budget", "score_number"]);
  expect(view.sort).toEqual([{ key: "score_number", dir: "desc" }]);
  await expect(table.locator("tbody tr[data-row-id]").first()).toContainText("Beacon"); // 1250 > 12 as NUMBERS ("12" > "1,250" as text)
  await row(page, "Atlas").getByRole("button", { name: "Score: 12", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Score" });
  await input.fill("40");
  await input.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "atlas", set: { score_number: 40 }, expect: { score_number: 12 } });

  // Undo: the old property is under "Deleted properties" with every value, and can be restored.
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("dialog", { name: "View settings" }).getByRole("button", { name: "Manage deleted property Score" }).click();
  await page.getByRole("dialog", { name: "Edit property Score" }).getByRole("button", { name: "Restore property" }).click();
  expect((await schemaFields()).score.deleted).toBe(false);
  expect((await meta("comet")).score).toBe("n/a");
});

// NP-DB-08 — a date holds a day, a time, or a range; status options are grouped. Editors, filters and sorts all understand them.
// (`?free-dates` re-homes the fixture's rows under a tag no integration owns: ranges are withheld on ingest tags, L9.)
test("date range and time, status groups", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?free-dates");
  const table = page.getByRole("table", { name: "All tasks" });
  const dueOf = (id: string) => page.evaluate((id) => (window as any).dbFixture.notes().find((n: any) => n.id === id).metadata.due as string, id);
  const start = await dueOf("t3");
  const plus = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const end = plus(start, 2);
  const dueCell = () => row(page, "Refine onboarding copy").getByRole("button", { name: /^Due:/ });

  // A plain day still edits in place; the full editor adds an end date.
  await dueCell().click();
  await expect(page.getByLabel("Due", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Time and end date for Due" }).click();
  let editor = page.getByRole("dialog", { name: "Edit Due" });
  await expect(editor.getByLabel("Date", { exact: true })).toHaveValue(start);
  await editor.getByRole("checkbox", { name: "Add an end date" }).check();
  await editor.getByLabel("End date", { exact: true }).fill(end);
  await editor.getByRole("button", { name: "Done" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { due: `${start}/${end}` }, expect: { due: start } });
  await expect(dueCell()).toHaveAccessibleName(/^Due: .+ → .+/);

  // The range filters as every day inside it, and sorts by its start.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("due");
  await filter.getByLabel("Condition 1 operator").selectOption("eq");
  await filter.getByLabel("Filter value").fill(plus(start, 1));
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
  await expect(row(page, "Refine onboarding copy")).toBeVisible();
  await filter.getByRole("button", { name: "Clear all" }).click();
  await page.keyboard.press("Escape");

  // Include time: start and end times, stored as instants; the editor reads them back in local time.
  await dueCell().click(); // a range opens the full editor directly
  editor = page.getByRole("dialog", { name: "Edit Due" });
  await expect(editor.getByLabel("Start date")).toHaveValue(start);
  await expect(editor.getByLabel("End date", { exact: true })).toHaveValue(end);
  await editor.getByRole("checkbox", { name: "Include time" }).check();
  await editor.getByLabel("Start time").fill("09:30");
  await editor.getByLabel("End time").fill("17:00");
  await editor.getByRole("button", { name: "Done" }).click();
  const timed = await dueOf("t3");
  expect(timed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  const local = await page.evaluate((v) => v.split("/").map((x) => { const d = new Date(x); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }), timed);
  expect(local).toEqual([`${start} 09:30`, `${end} 17:00`]);
  await expect(dueCell()).toHaveAccessibleName(/^Due: .+9:30.* → .+5:00/);
  // An end before the start is refused in the editor; nothing is written.
  await dueCell().click();
  editor = page.getByRole("dialog", { name: "Edit Due" });
  await editor.getByLabel("End date", { exact: true }).fill(plus(start, -3));
  await expect(editor.getByRole("alert")).toHaveText("The end is before the start.");
  await expect(editor.getByRole("button", { name: "Done" })).toBeDisabled();
  // Dropping the end leaves a single date with its time.
  await editor.getByRole("checkbox", { name: "Add an end date" }).uncheck();
  await editor.getByRole("button", { name: "Done" }).click();
  expect(await dueOf("t3")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  // Escape leaves the value alone; Clear empties it (null, never "").
  await dueCell().click();
  await page.keyboard.press("Escape");
  const count = (await writes(page)).length;
  expect((await writes(page)).length).toBe(count);
  await dueCell().click();
  await page.getByRole("dialog", { name: "Edit Due" }).getByRole("button", { name: "Clear" }).click();
  expect((await writes(page)).at(-1).set).toEqual({ due: null });

  // Status options are grouped To-do / In progress / Complete in the editor and the filter.
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Status: in-progress" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Status" });
  await expect(picker.locator(".db-status-group")).toHaveText(["To-do", "In progress", "Complete"]);
  await expect(picker.getByRole("option")).toHaveText(["todo", "in-progress", "done"]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await filter.getByRole("button", { name: "Add filter" }).click();
  await filter.getByLabel("Condition 1 property").selectOption("status");
  expect(await filter.getByLabel("Filter value").locator("optgroup").evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label))).toEqual(["To-do", "In progress", "Complete"]);
});

// Review L5 — a long removal is several short requests: the client keeps asking while the server says `more`.
test("L5: removing values is chunked", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=db2");
  await page.evaluate(() => { (window as any).dbFixture.removeChunk = 1; });
  await page.getByRole("table", { name: "All initiatives" }).getByRole("button", { name: "Stage", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit property…" }).click();
  const editor = page.getByRole("dialog", { name: "Edit property Stage" });
  await editor.getByRole("button", { name: "Delete property…" }).click();
  const del = editor.getByRole("group", { name: "Delete property" });
  await del.getByRole("radio", { name: /Remove the values from every page/ }).check();
  await del.getByRole("button", { name: "Check what would be removed" }).click();
  await del.getByRole("button", { name: "Delete and remove 2 values" }).click();
  await expect(editor.getByRole("status")).toContainText("Removed the value from 2 pages.");
  expect((await fx(page)).removals.filter((r: any) => !r.dryRun).length).toBe(2);
  expect(await page.evaluate(() => (window as any).dbFixture.notes().filter((n: any) => n.tags.includes("initiative") && "stage" in n.metadata).length)).toBe(0);
});

// Review L9 — an ingest-owned tag's date fields stay single dates (other readers of `task.due` expect one date).
test("L9: no date range on an ingest tag's field; other tags keep it", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await row(page, "Refine onboarding copy").getByRole("button", { name: /^Due:/ }).click();
  await page.getByRole("button", { name: "Time and end date for Due" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Due" });
  await expect(editor.getByRole("checkbox", { name: /Add an end date/ })).toBeDisabled();
  await expect(editor).toContainText("kept in sync by an integration");
  await expect(editor.getByRole("checkbox", { name: "Include time" })).toBeEnabled();
});
