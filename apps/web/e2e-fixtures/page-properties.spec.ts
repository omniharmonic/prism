import { test, expect, type Page } from "@playwright/test";

const state = (page: Page) => page.evaluate(() => { const f = (window as any).dbFixture; return { writes: f.writes, schemaWrites: f.schemaWrites, page: f.notes().find((n: any) => n.id === "page") }; });
const bar = (page: Page) => page.getByRole("group", { name: "Page properties" });

test("properties under the title: typed values, metadata-only CAS writes, empty fields behind Add property", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  await expect(page.locator(".tiptap")).toContainText("A single, evolving place");
  const props = bar(page);
  await expect(props.getByRole("button", { name: "Status: In progress" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Priority: Medium" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Owner: Alex Chen" })).toBeVisible(); // a free metadata key
  await expect(props.getByRole("button", { name: /^Due:/ })).toHaveCount(0); // empty → hidden
  await page.screenshot({ path: info.outputPath("page-properties-1440.png") });

  await props.getByRole("button", { name: "Status: In progress" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "Done" }).click();
  await expect(props.getByRole("button", { name: "Status: Done" })).toBeVisible();
  let s = await state(page);
  expect(s.writes).toEqual([{ id: "page", set: { status: "done" }, expect: { status: "in-progress" } }]);
  expect(s.page.content).toContain("A single, evolving place"); // the body is never written

  await props.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name: /Due$/ }).click();
  const due = page.getByLabel("Due", { exact: true });
  await expect(due).toBeFocused();
  await due.fill("2026-11-02");
  await due.press("Enter");
  await expect(props.getByRole("button", { name: /^Due: Nov 2/ })).toBeVisible();
  s = await state(page);
  expect(s.writes.at(-1)).toEqual({ id: "page", set: { due: "2026-11-02" }, expect: { due: null } });

  // Clearing a value writes null (merge-patch delete), never an empty string.
  await props.getByRole("button", { name: "Priority: Medium" }).click();
  await page.getByRole("dialog", { name: "Choose Priority" }).getByRole("button", { name: "Clear" }).click();
  await expect(props.getByRole("button", { name: /^Priority:/ })).toHaveCount(0);
  expect((await state(page)).writes.at(-1)).toEqual({ id: "page", set: { priority: null }, expect: { priority: "medium" } });
});

test("owner adds a typed property and a new option through the schema", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const props = bar(page);
  await props.getByRole("button", { name: "Add property" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a property" });
  await expect(dialog).toContainText("New property on every “task” page");
  await dialog.getByLabel("Property name").fill("Effort");
  await dialog.getByLabel("Property type").selectOption("number");
  await dialog.getByRole("button", { name: "Add property" }).click();
  const effort = page.getByLabel("Effort", { exact: true });
  await expect(effort).toBeFocused();
  await effort.fill("4");
  await effort.press("Enter");
  let s = await state(page);
  expect(s.schemaWrites[0]).toEqual({ tag: "task", patch: { fields: { effort: { type: "number" } }, ui: { effort: { kind: "number", label: "Effort" } } } });
  expect(s.writes.at(-1)).toEqual({ id: "page", set: { effort: 4 }, expect: { effort: null } });

  await props.getByRole("button", { name: "Priority: Medium" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Priority" });
  await picker.getByLabel("Search Priority options").fill("urgent");
  await picker.getByRole("button", { name: /Create/ }).click();
  await expect(props.getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
  s = await state(page);
  expect(s.schemaWrites.at(-1)).toEqual({ tag: "task", patch: { fields: { priority: { enum: ["low", "medium", "high", "urgent"] } } } });
  expect(s.writes.at(-1)).toEqual({ id: "page", set: { priority: "urgent" }, expect: { priority: "medium" } });
});

test("tags use a searchable checklist", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const props = bar(page);
  await props.getByRole("button", { name: "Add tag" }).click();
  const picker = page.getByRole("dialog", { name: "Choose tags" });
  await picker.getByLabel("Search tags").fill("plan");
  await picker.getByRole("menuitemcheckbox", { name: /planning/ }).click();
  await expect(props.getByRole("button", { name: "Remove tag planning" })).toBeVisible();
  await props.getByRole("button", { name: "Remove tag research" }).click();
  await expect(props.getByRole("button", { name: "Remove tag research" })).toHaveCount(0);
  expect((await state(page)).page.tags).toEqual(["task", "planning"]);
});

test("person picker links a person note as a wikilink", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const props = bar(page);
  await props.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name: /Assignee$/ }).click();
  const picker = page.getByRole("dialog", { name: "Link Assignee" });
  await picker.getByLabel("Search people").fill("sam");
  await picker.getByRole("option", { name: /Sam Rivera/ }).click();
  await expect(props.getByRole("button", { name: "Assignee: Sam Rivera" })).toBeVisible();
  expect((await state(page)).writes.at(-1)).toEqual({ id: "page", set: { assignee: "[[People/Sam Rivera]]" }, expect: { assignee: null } });
});

test("viewers see properties without edit affordances", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page&viewer");
  const props = bar(page);
  await expect(props.getByRole("button", { name: "Status: In progress" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Add property" })).toHaveCount(0);
  await expect(props.getByRole("button", { name: "Add tag" })).toHaveCount(0);
  await props.getByRole("button", { name: "Status: In progress" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Status" })).toHaveCount(0);
  expect((await state(page)).writes).toEqual([]);
});

// NP-DB-11 — rename, change type (with a preview), edit options and delete are presentation changes: no stored value moves.
test("rename, retype with preview, delete property", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const props = bar(page);
  const stored = async () => (await state(page)).page.metadata;
  const lastSchema = async () => (await state(page)).schemaWrites.at(-1);

  // Rename: a label. The metadata key and the value stay.
  await props.getByRole("button", { name: "Edit property Status" }).click();
  await page.getByRole("dialog", { name: "Edit property Status" }).getByLabel("Property name").fill("Stage");
  await page.getByRole("dialog", { name: "Edit property Status" }).getByRole("button", { name: "Rename" }).click();
  const editor = page.getByRole("dialog", { name: "Edit property Stage" });
  await expect(editor).toBeVisible();
  expect(await lastSchema()).toEqual({ tag: "task", patch: { ui: { status: { label: "Stage" } } } });
  await expect(props.getByRole("button", { name: "Stage: In progress" })).toBeVisible();
  expect((await stored()).status).toBe("in-progress");

  // Options: rename, recolour, reorder — all hints over the stored value.
  await editor.getByLabel("Name of option in-progress").fill("Doing");
  await editor.getByLabel("Name of option in-progress").blur();
  await expect(props.getByRole("button", { name: "Stage: Doing" })).toBeVisible();
  expect(await lastSchema()).toEqual({ tag: "task", patch: { ui: { status: { optionLabels: { "in-progress": "Doing" } } } } });
  await editor.getByLabel("Colour of Doing").selectOption("red");
  await expect(props.locator('.db-opt[data-value="in-progress"]')).toHaveAttribute("data-color", "red");
  const names = () => editor.getByRole("list", { name: "Options", exact: true }).getByRole("textbox").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(await names()).toEqual(["To do", "Doing", "Done"]);
  await editor.getByRole("button", { name: "Move Doing up" }).click();
  await expect.poll(names).toEqual(["Doing", "To do", "Done"]);
  expect(await lastSchema()).toEqual({ tag: "task", patch: { ui: { status: { optionOrder: ["in-progress", "todo", "done"] } } } });
  // Deleting an option pages still use is refused, with the count; an unused one is hidden and can be restored.
  await editor.getByRole("button", { name: "Delete option To do" }).click();
  await expect(editor.getByRole("alert")).toContainText("2 pages still use “todo”");
  await expect.poll(names).toEqual(["Doing", "To do", "Done"]);
  await editor.getByLabel("New option").fill("blocked");
  await editor.getByRole("button", { name: "Add option" }).click();
  expect(await lastSchema()).toEqual({ tag: "task", patch: { fields: { status: { enum: ["todo", "in-progress", "done", "blocked"] } }, ui: { status: {} } } });
  await expect.poll(names).toEqual(["Doing", "To do", "Done", "Blocked"]);
  await editor.getByRole("button", { name: "Delete option Blocked" }).click();
  await expect.poll(names).toEqual(["Doing", "To do", "Done"]);
  await expect(editor.getByRole("list", { name: "Deleted options" })).toContainText("Blocked (deleted)");
  await editor.getByRole("button", { name: "Restore option Blocked" }).click();
  await expect.poll(names).toEqual(["Doing", "To do", "Done", "Blocked"]);
  expect((await stored()).status).toBe("in-progress"); // never rewritten
  await editor.getByRole("button", { name: "Close" }).click();

  // Change type: only presentations of the same vault type are offered, with a preview of how values will read.
  await props.getByRole("button", { name: "Edit property Priority" }).click();
  const priority = page.getByRole("dialog", { name: "Edit property Priority" });
  const type = priority.getByLabel("Property type");
  await expect(type).toHaveValue("select");
  await expect(type.locator('option[value="number"]')).toHaveJSProperty("disabled", true);
  await expect(type.locator('option[value="checkbox"]')).toHaveJSProperty("disabled", true);
  await expect(type.locator('option[value="status"]')).toHaveJSProperty("disabled", false);
  await expect(priority).toContainText("Other types would change stored values; Prism never does that");
  await type.selectOption("status");
  const preview = priority.getByRole("group", { name: "Type change preview" });
  await expect(preview).toContainText("1 of 1 value will show as Status");
  await expect(preview).toContainText("No stored value changes");
  await expect(preview.getByRole("list", { name: "Examples" })).toContainText("Medium");
  const before = (await state(page)).schemaWrites.length;
  await preview.getByRole("button", { name: "Cancel" }).click();
  expect((await state(page)).schemaWrites.length).toBe(before); // the preview writes nothing
  await type.selectOption("status");
  await priority.getByRole("button", { name: "Change type to Status" }).click();
  expect(await lastSchema()).toEqual({ tag: "task", patch: { ui: { priority: { kind: "status" } } } });
  await expect(type).toHaveValue("status");
  await expect(priority.getByLabel("Group of medium")).toHaveValue("in_progress");
  expect((await stored()).priority).toBe("medium");

  // Delete with explicit data handling: keep the values → hidden everywhere, restorable.
  await priority.getByRole("button", { name: "Delete property…" }).click();
  const del = priority.getByRole("group", { name: "Delete property" });
  await expect(del.getByRole("radio", { name: /Keep the values/ })).toBeChecked();
  await del.getByRole("button", { name: "Delete property", exact: true }).click();
  expect(await lastSchema()).toEqual({ tag: "task", patch: { ui: { priority: { deleted: true } } } });
  await expect(priority.getByRole("region", { name: "Deleted property" })).toContainText("hidden on every page, view and filter");
  await expect(props.getByRole("button", { name: /^Priority:/ })).toHaveCount(0);
  expect((await stored()).priority).toBe("medium"); // hiding removes nothing
  // Removing values of an ingest-owned tag is refused by the server; nothing is lost.
  await priority.getByRole("button", { name: "Remove its values…" }).click();
  await expect(priority.getByRole("alert")).toContainText("Values of an ingested tag are never removed in bulk");
  expect((await stored()).priority).toBe("medium");
  await priority.getByRole("button", { name: "Close" }).click();
  // Restore from "Add property" → Deleted properties.
  await props.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name: "Manage deleted property Priority" }).click();
  await page.getByRole("dialog", { name: "Edit property Priority" }).getByRole("button", { name: "Restore property" }).click();
  await expect(props.getByRole("button", { name: "Priority: Medium" })).toBeVisible();
  expect((await state(page)).writes).toEqual([]); // no page was written by any of this
});

test("non-owners see no schema controls", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page&viewer");
  await expect(bar(page).getByRole("button", { name: "Status: In progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit property/ })).toHaveCount(0);
  await page.goto("/e2e-fixtures/databases.html?viewer");
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Sort ascending" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit property…" })).toHaveCount(0);
});

for (const appearance of ["phone", "dark"])
  test(`property bar ${appearance}`, async ({ page }, info) => {
    if (appearance === "phone") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e-fixtures/databases.html?open=page${appearance === "dark" ? "&dark" : ""}`);
    await expect(bar(page).getByRole("button", { name: "Status: In progress" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (appearance === "phone")
      for (const b of await bar(page).getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`page-properties-${appearance}.png`) });
  });

// ── pinned properties (the tag's `pinned` hint: what every page with the tag shows at the top) ──

const keysShown = (page: Page) => bar(page).locator(".db-prop[data-property-key]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.propertyKey));

test("owner pins properties: exact order, empty ones as placeholders, the rest behind “more”, kept after a reload", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  const props = bar(page);
  await expect(props.getByRole("button", { name: "Status: in-progress" })).toBeVisible();
  expect(await keysShown(page)).toEqual(["status", "priority", "owner"]); // no hint → every filled property
  await expect(props.getByRole("button", { name: /more propert/ })).toHaveCount(0);

  await props.getByRole("button", { name: "Customize…" }).click();
  const dialog = page.getByRole("dialog", { name: "Customize properties" });
  await expect(dialog).toContainText("Show at the top of every “task” page");
  await dialog.getByLabel("Show Priority at top").check();
  await dialog.getByLabel("Show Due at top").check();
  await expect.poll(() => keysShown(page)).toEqual(["priority", "due"]);
  expect((await state(page)).schemaWrites).toEqual([{ tag: "task", patch: { pinned: ["priority"] } }, { tag: "task", patch: { pinned: ["priority", "due"] } }]);

  // Keyboard reorder: Due above Priority.
  const up = dialog.getByRole("button", { name: "Move Due up" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => keysShown(page)).toEqual(["due", "priority"]);
  expect((await state(page)).schemaWrites.at(-1)).toEqual({ tag: "task", patch: { pinned: ["due", "priority"] } });
  await expect(dialog.getByRole("button", { name: "Move Due up" })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: info.outputPath("pinned-customize.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The empty pinned property is a quiet placeholder that can be filled in place.
  await expect(props.getByRole("button", { name: "Due: Empty" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Status: in-progress" })).toHaveCount(0);
  const more = props.getByRole("button", { name: "2 more properties" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await keysShown(page)).toEqual(["due", "priority", "status", "owner"]);
  expect((await state(page)).writes).toEqual([]); // choosing a layout writes no page
  await page.screenshot({ path: info.outputPath("pinned-bar.png") });

  await page.reload();
  await expect(bar(page).getByRole("button", { name: "Due: Empty" })).toBeVisible();
  expect(await keysShown(page)).toEqual(["due", "priority"]);
  await expect(bar(page).getByRole("button", { name: "2 more properties" })).toHaveAttribute("aria-expanded", "false");

  // Filling the placeholder is an ordinary property write.
  await bar(page).getByRole("button", { name: "Due: Empty" }).click();
  const due = page.getByLabel("Due", { exact: true });
  await due.fill("2026-11-02");
  await due.press("Enter");
  await expect(bar(page).getByRole("button", { name: /^Due: Nov 2/ })).toBeVisible();
  expect((await state(page)).writes.at(-1)).toEqual({ id: "page", set: { due: "2026-11-02" }, expect: { due: null } });

  // Back to "every filled property".
  await bar(page).getByRole("button", { name: "Customize…" }).click();
  await page.getByRole("dialog", { name: "Customize properties" }).getByRole("button", { name: "Show every filled property instead" }).click();
  await expect.poll(() => keysShown(page)).toEqual(["status", "priority", "due", "owner"]);
  expect((await state(page)).schemaWrites.at(-1)).toEqual({ tag: "task", patch: { pinned: [] } });
});

test("a non-owner sees the pinned layout and no Customize", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  await bar(page).getByRole("button", { name: "Customize…" }).click();
  const dialog = page.getByRole("dialog", { name: "Customize properties" });
  await dialog.getByLabel("Show Due at top").check();
  await dialog.getByLabel("Show Status at top").check();
  await expect.poll(() => keysShown(page)).toEqual(["due", "status"]);

  await page.goto("/e2e-fixtures/databases.html?open=page&viewer"); // same tab: the fixture keeps its schemas
  const props = bar(page);
  await expect(props.getByRole("button", { name: "Due: Empty" })).toBeVisible(); // the placeholder, with nothing to edit
  await expect(props.getByRole("button", { name: "Add property" })).toHaveCount(0);
  expect(await keysShown(page)).toEqual(["due", "status"]);
  await expect(page.getByRole("button", { name: "Customize…" })).toHaveCount(0);
  await props.getByRole("button", { name: "2 more properties" }).click();
  expect(await keysShown(page)).toEqual(["due", "status", "priority", "owner"]);
});

test("pinned layout on a phone: 44px targets, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html?open=page");
  await bar(page).getByRole("button", { name: "Customize…" }).click();
  const dialog = page.getByRole("dialog", { name: "Customize properties" });
  await dialog.getByLabel("Show Due at top").check();
  await dialog.getByLabel("Show Priority at top").check();
  for (const b of await dialog.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  for (const b of await bar(page).getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// NP-PG-05 — the last [T] of the row (PARITY-GAPS §a.2): the checkbox, URL and number editors UNDER THE TITLE.
// The table's editors are asserted in databases / parity3-databases; this is the page property bar.
test("NP-PG-05: checkbox, URL and number editors under the title — typed editors, per-field compare-and-set, the body untouched", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  await expect(page.locator(".tiptap")).toContainText("A single, evolving place");
  const props = bar(page);
  const add = async (name: RegExp) => {
    await props.getByRole("button", { name: "Add property" }).click();
    await page.getByRole("dialog", { name: "Add a property" }).getByRole("button", { name }).click();
  };
  const last = async () => (await state(page)).writes.at(-1);

  // Number: a numeric input, stored as a NUMBER (not "6"), shown under the title; a second edit compares against the first.
  await add(/Estimate \(h\)$/);
  const estimate = page.getByLabel("Estimate (h)", { exact: true });
  await expect(estimate).toBeFocused();
  expect(await estimate.evaluate((el) => (el as HTMLInputElement).inputMode || (el as HTMLInputElement).type)).toMatch(/decimal|numeric|number/);
  await estimate.fill("6");
  await estimate.press("Enter");
  expect(await last()).toEqual({ id: "page", set: { estimate: 6 }, expect: { estimate: null } });
  await props.getByRole("button", { name: "Estimate (h): 6" }).click();
  await page.getByLabel("Estimate (h)", { exact: true }).fill("7.5");
  await page.keyboard.press("Enter");
  expect(await last()).toEqual({ id: "page", set: { estimate: 7.5 }, expect: { estimate: 6 } });
  await expect(props.getByRole("button", { name: "Estimate (h): 7.5" })).toBeVisible();
  // Escape leaves the value alone.
  await props.getByRole("button", { name: "Estimate (h): 7.5" }).click();
  await page.getByLabel("Estimate (h)", { exact: true }).fill("99");
  await page.keyboard.press("Escape");
  await expect(props.getByRole("button", { name: "Estimate (h): 7.5" })).toBeVisible();
  expect(await last()).toEqual({ id: "page", set: { estimate: 7.5 }, expect: { estimate: 6 } });

  // URL: a url input; the stored value is shown as a real link that opens in a new tab.
  await add(/Link$/);
  const link = page.getByRole("textbox", { name: "Link", exact: true });
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute("type", "url");
  await link.fill("https://example.test/handbook");
  await link.press("Enter");
  expect(await last()).toEqual({ id: "page", set: { link: "https://example.test/handbook" }, expect: { link: null } });
  const anchor = props.getByRole("link", { name: /example\.test\/handbook/ });
  await expect(anchor).toHaveAttribute("href", "https://example.test/handbook");
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAttribute("rel", /noopener/);
  // Text that is not a web address is REFUSED beside the field (nothing is written, the stored link stays).
  const before = (await state(page)).writes.length;
  await props.getByRole("button", { name: /^Link: / }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("javascript:alert(1)");
  await page.keyboard.press("Enter");
  await expect(props.getByRole("alert")).toContainText("That isn’t a web address");
  expect((await state(page)).writes.length).toBe(before);
  await expect(props.locator('a[href^="javascript:" i]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(props.getByRole("link", { name: /example\.test\/handbook/ })).toBeVisible();

  // Checkbox: a real checkbox. Adding it under the title shows it UNTICKED and writes nothing
  // (it used to tick itself — twice — because "open the editor of the property just added" toggled it).
  await add(/Flagged$/);
  const flagged = props.getByRole("checkbox", { name: "Flagged" });
  const flagWrites = async () => (await state(page)).writes.filter((w: any) => "flagged" in (w.set ?? {})).map((w: any) => ({ set: w.set, expect: w.expect }));
  await expect(flagged).toBeVisible();
  await expect(flagged).not.toBeChecked();
  await page.waitForTimeout(300);
  expect(await flagWrites()).toEqual([]);
  const ticked = { set: { flagged: true }, expect: { flagged: null } };
  await flagged.click();
  await expect(flagged).toBeChecked();
  await expect.poll(flagWrites).toEqual([ticked]);
  await flagged.click();
  await expect(flagged).not.toBeChecked();
  await expect.poll(flagWrites).toEqual([ticked, { set: { flagged: false }, expect: { flagged: true } }]);

  // Every write was metadata only: the body was never sent, and no schema changed.
  const s = await state(page);
  expect(s.page.content).toContain("A single, evolving place");
  expect(s.writes.every((w: any) => w.id === "page" && w.set && !("content" in w))).toBe(true);
  expect(s.schemaWrites).toEqual([]);
  expect(s.page.metadata).toMatchObject({ estimate: 7.5, flagged: false });
});
