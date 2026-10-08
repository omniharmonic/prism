import { test, expect, type Page } from "@playwright/test";

// A (one-step property creation), B (relation targets: search only the target, create inline,
// read every stored encoding, write a full-path wikilink).
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const writes = async (page: Page) => ((await fx(page)).writes as any[]).filter((w: any) => !w.metadata?.prism_database);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });
const tabs = (page: Page) => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId) as string[]);

async function showColumns(page: Page, labels: string[]) {
  await page.getByRole("button", { name: "View settings" }).click();
  const settings = page.getByRole("dialog", { name: "View settings" });
  for (const l of labels) await settings.getByRole("list", { name: "Visible properties" }).getByRole("checkbox", { name: l, exact: true }).check();
  await page.keyboard.press("Escape");
}

test("A: the table's + column creates a status property with its options in ONE schema write", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.locator("tbody tr[data-row-id]").first()).toBeVisible();
  await table.getByRole("button", { name: "New property" }).click();
  const dialog = page.getByRole("dialog", { name: "New property" });
  await expect(dialog).toContainText("New property on every “task” page");
  await dialog.getByLabel("Property name").fill("Stage");
  await dialog.getByLabel("Property type").selectOption("status");
  // Status starts with the three groups filled in; every option is editable before anything is saved.
  const options = dialog.getByRole("list", { name: "Options of the new property" });
  await expect(options.getByRole("listitem")).toHaveCount(3);
  await dialog.getByLabel("Option 1", { exact: true }).fill("Idea");
  await dialog.getByLabel("Colour of option 1").selectOption("purple");
  await dialog.getByLabel("New option", { exact: true }).fill("Blocked");
  await dialog.getByRole("button", { name: "Add option" }).click();
  await dialog.getByLabel("Group of option 4").selectOption("todo");
  await dialog.getByRole("button", { name: "Move option 4 up" }).click();
  await dialog.getByRole("button", { name: "Add property" }).click();
  await expect(dialog).toHaveCount(0);

  const schemaWrites = (await fx(page)).schemaWrites as any[];
  expect(schemaWrites).toEqual([{ tag: "task", patch: {
    fields: { stage: { type: "string", enum: ["Idea", "In progress", "Blocked", "Done"] } },
    ui: { stage: {
      kind: "status", label: "Stage",
      colors: { Idea: "purple", "In progress": "blue", Blocked: "red", Done: "green" },
      optionOrder: ["Idea", "In progress", "Blocked", "Done"],
      statusGroups: { Idea: "todo", "In progress": "in_progress", Blocked: "todo", Done: "complete" },
    } },
  } }]);
  // The new column is in the view at once, and its picker already has the options, grouped.
  await expect(table.locator("thead th").last()).toHaveText("Stage");
  await row(page, "Refine onboarding copy").getByRole("button", { name: "Stage: Empty" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Stage" });
  await expect(picker.locator('[data-status-group="todo"]')).toBeVisible();
  await picker.getByRole("option", { name: "Blocked" }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { stage: "Blocked" }, expect: { stage: null } });
});

test("A: an editor who may not change the schema is told why at the + column", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?viewer");
  // A viewer can't edit the database at all: no + column.
  await expect(page.getByRole("table", { name: "All tasks" }).getByRole("button", { name: "New property" })).toHaveCount(0);
});

test("B: a new relation finds its target from the name, searches only it, and creates a page inline", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=t3");
  const bar = page.getByRole("group", { name: "Page properties" });
  await bar.getByRole("button", { name: "Add property" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a property" });
  await dialog.getByLabel("Property name").fill("Initiatives");
  await dialog.getByLabel("Property type").selectOption("relation");
  // "Initiatives" → #initiative (a tag with a schema), several pages (a plural name).
  await expect(dialog.getByLabel("Related database tag")).toHaveValue("initiative");
  await expect(dialog.getByLabel("Allow multiple")).toBeChecked();
  await dialog.getByRole("button", { name: "Add property" }).click();
  expect(((await fx(page)).schemaWrites as any[]).at(-1)).toEqual({ tag: "task", patch: {
    fields: { initiatives: { type: "array" } },
    ui: { initiatives: { kind: "relation", label: "Initiatives", relationTag: "initiative", multiple: true } },
  } });

  // The picker opens on the new property and lists ONLY #initiative pages, before anything is typed.
  const picker = page.getByRole("dialog", { name: "Link Initiatives" });
  await expect(picker.getByRole("option", { name: /Atlas/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Beacon/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Mira Chen/ })).toHaveCount(0);
  await expect(picker.getByRole("option", { name: /Refine onboarding/ })).toHaveCount(0);

  // Nothing called "Gamma": create it in the target, beside its pages, and link it.
  await picker.getByRole("textbox", { name: "Search pages" }).fill("Gamma");
  await expect(picker.getByRole("option")).toHaveCount(0);
  await picker.getByRole("button", { name: /Create “Gamma”/ }).click();
  await expect.poll(async () => ((await fx(page)).creates as any[]).at(-1)).toEqual({ content: "", path: "Projects/Gamma", tags: ["initiative"], metadata: { title: "Gamma" } });
  await expect.poll(async () => (await writes(page)).at(-1)).toEqual({ id: "t3", set: { initiatives: ["[[Projects/Gamma]]"] }, expect: { initiatives: null } });
  // An exact name offers no Create (pick it instead).
  await picker.getByRole("textbox", { name: "Search pages" }).fill("atlas");
  await expect(picker.getByRole("button", { name: /Create/ })).toHaveCount(0);
  await picker.getByRole("option", { name: /Atlas/ }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { initiatives: ["[[Projects/Gamma]]", "[[Projects/Atlas]]"] }, expect: { initiatives: ["[[Projects/Gamma]]"] } });
  await page.keyboard.press("Escape");
  await expect(bar.getByRole("button", { name: /^Initiatives:/ })).toContainText("Gamma");
});

test("B: stored values in every encoding read as their page; a choice is written as a full-path wikilink", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?relations");
  await showColumns(page, ["Project"]);
  const chip = (title: string) => row(page, title).locator(".db-link-chip");
  await expect(chip("Folder-linked task")).toHaveText("Orion");       // [[Initiatives/orion]] → …/orion/PROJECT
  await expect(chip("Slug-linked task")).toHaveText("Beacon");        // beacon
  await expect(chip("Name-linked task")).toHaveText("Atlas");         // Atlas
  await expect(chip("Unknown-linked task")).toHaveText("Nebula");     // no such page: shown as text, never guessed
  await expect(chip("Unknown-linked task")).toHaveAttribute("data-unlinked", "true");
  await expect(chip("Empty-linked task")).toHaveCount(0);             // "" is empty
  await expect(chip("Folder-linked task")).toHaveAttribute("data-resolved-via", "folder");

  // A dangling folder link still opens the page it means.
  await chip("Folder-linked task").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => tabs(page)).toContain("orion");

  // The picker shows the slug value as the page it means; a new choice is written in the one canonical form.
  await page.goto("/e2e-fixtures/databases.html?relations");
  await row(page, "Slug-linked task").getByRole("button", { name: /^Project:/ }).click();
  const picker = page.getByRole("dialog", { name: "Link Project" });
  await expect(picker.getByRole("option", { name: /Beacon/ })).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("option", { name: /Orion/ }).click();
  expect((await writes(page)).at(-1)).toEqual({ id: "r2", set: { project: "[[Initiatives/orion/PROJECT]]" }, expect: { project: "beacon" } });
  expect(await writes(page)).toHaveLength(1); // reading never wrote anything
});
