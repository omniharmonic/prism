import { test, expect, type Page } from "@playwright/test";

const state = (page: Page) => page.evaluate(() => { const f = (window as any).dbFixture; return { writes: f.writes, schemaWrites: f.schemaWrites, page: f.notes().find((n: any) => n.id === "page") }; });
const bar = (page: Page) => page.getByRole("group", { name: "Page properties" });

test("properties under the title: typed values, metadata-only CAS writes, empty fields behind Add property", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html?open=page");
  await expect(page.locator(".tiptap")).toContainText("A single, evolving place");
  const props = bar(page);
  await expect(props.getByRole("button", { name: "Status: in-progress" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Priority: medium" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Owner: Alex Chen" })).toBeVisible(); // a free metadata key
  await expect(props.getByRole("button", { name: /^Due:/ })).toHaveCount(0); // empty → hidden
  await page.screenshot({ path: info.outputPath("page-properties-1440.png") });

  await props.getByRole("button", { name: "Status: in-progress" }).click();
  await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "done" }).click();
  await expect(props.getByRole("button", { name: "Status: done" })).toBeVisible();
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
  await props.getByRole("button", { name: "Priority: medium" }).click();
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

  await props.getByRole("button", { name: "Priority: medium" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Priority" });
  await picker.getByLabel("Search Priority options").fill("urgent");
  await picker.getByRole("button", { name: /Create/ }).click();
  await expect(props.getByRole("button", { name: "Priority: urgent" })).toBeVisible();
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
  await expect(props.getByRole("button", { name: "Status: in-progress" })).toBeVisible();
  await expect(props.getByRole("button", { name: "Add property" })).toHaveCount(0);
  await expect(props.getByRole("button", { name: "Add tag" })).toHaveCount(0);
  await props.getByRole("button", { name: "Status: in-progress" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Status" })).toHaveCount(0);
  expect((await state(page)).writes).toEqual([]);
});

for (const appearance of ["phone", "dark"])
  test(`property bar ${appearance}`, async ({ page }, info) => {
    if (appearance === "phone") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e-fixtures/databases.html?open=page${appearance === "dark" ? "&dark" : ""}`);
    await expect(bar(page).getByRole("button", { name: "Status: in-progress" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (appearance === "phone")
      for (const b of await bar(page).getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`page-properties-${appearance}.png`) });
  });
