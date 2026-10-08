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
