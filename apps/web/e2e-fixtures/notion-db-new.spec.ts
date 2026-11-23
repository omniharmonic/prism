import { test, expect, type Page } from "@playwright/test";

/**
 * "New database" — Blank with schema: a name mints a NEW tag (the server's availability decides), the first
 * properties come from the one-step property form (a Status starter is offered), the first view is chosen, and
 * create = page → schema (requireNew) → view. Owners only; everyone else is offered "Use an existing tag".
 */
// The fixture compiles the database surface on first load; a busy host needs the slow budget.
test.beforeEach(() => { test.slow(); });
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);

async function openNewDatabase(page: Page) {
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByRole("button", { name: "Page", exact: true }).click();
  await create.getByRole("button", { name: "Database", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New database" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("new database: name → minted tag → three properties incl. a relation → table; a row shows the columns", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  const dialog = await openNewDatabase(page);
  await dialog.getByLabel("Database name").fill("Reading list");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("reading-list");
  await expect(dialog.getByText("Every page of this database will be tagged #reading-list")).toBeVisible();
  expect((await fx(page)).availability).toContain("reading-list");

  // The Status starter is offered with To do / In progress / Done.
  const props = dialog.getByRole("list", { name: "Properties of the new database" });
  await expect(props.getByRole("listitem")).toHaveCount(1);
  await expect(props).toContainText("Status");
  await expect(props).toContainText("To do, In progress, Done");

  // + Author (text)
  await dialog.getByRole("button", { name: "Add a property" }).click();
  await dialog.getByLabel("Property name").fill("Author");
  await dialog.getByRole("button", { name: "Add to the database" }).click();
  // + Project (relation to #project)
  await dialog.getByRole("button", { name: "Add a property" }).click();
  await dialog.getByLabel("Property name").fill("Project");
  await dialog.getByLabel("Property type").selectOption("relation");
  await dialog.getByLabel("Related database tag").fill("project");
  await dialog.getByRole("button", { name: "Add to the database" }).click();
  await expect(props.getByRole("listitem")).toHaveCount(3);
  await expect(props).toContainText("→ #project");
  // Reorder: Author first.
  await dialog.getByRole("button", { name: "Move Author up" }).click();
  await expect(props.getByRole("listitem").first()).toContainText("Author");
  // Nothing was written while defining it.
  let f = await fx(page);
  expect(f.schemaWrites).toEqual([]);
  expect(f.creates).toEqual([]);

  await dialog.getByRole("radio", { name: "Table" }).check();
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  f = await fx(page);
  expect(f.log).toEqual(["create", "schema", "config"]);
  expect(f.creates[0]).toMatchObject({ path: "Projects/Reading list", metadata: { prism_type: "database", title: "Reading list" } });
  expect(f.schemaWrites).toHaveLength(1);
  const w = f.schemaWrites[0];
  expect(w).toMatchObject({ tag: "reading-list", requireNew: true });
  expect(Object.keys(w.patch.fields)).toEqual(["author", "status", "project"]);
  expect(w.patch.fields.status).toEqual({ type: "string", enum: ["To do", "In progress", "Done"] });
  expect(w.patch.ui.project).toMatchObject({ kind: "relation", label: "Project", relationTag: "project" });
  const config = f.writes.find((x: any) => x.metadata?.prism_database);
  expect(config.metadata.prism_database).toEqual({ version: 1, source: { tags: ["reading-list"] }, views: [{ id: "table", name: "Table", type: "table", visible: ["author", "status", "project"] }] });
  expect(config.ifUpdatedAt).toBeTruthy();

  // The new database opens (empty) over its own tag; a row is added from the toolbar and the Table shows its columns.
  await expect(page.getByRole("heading", { name: "No pages yet" })).toBeVisible();
  await page.locator(".db-actions").getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(async () => (await fx(page)).creates.length).toBe(2);
  expect((await fx(page)).creates.at(-1)).toMatchObject({ tags: ["reading-list"], path: expect.stringMatching(/^Projects\/Reading list\//) });
  const table = page.getByRole("table", { name: "Table" });
  await expect(table.locator("thead th")).toHaveText(["Title", "Author", "Status", "Project"]);
  await expect(table.locator("tbody tr[data-row-id]")).toHaveCount(1);
});

test("new database: a taken tag is skipped when minting; an edited tag is checked; a board gets a status", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  // "research" is in use by a page: the name "Research" mints research-2.
  await page.evaluate(() => { (window as any).dbFixture.notes().push({ id: "r1", path: "X/R", content: "", tags: ["research"], metadata: {}, createdAt: "", updatedAt: "" }); });
  const dialog = await openNewDatabase(page);
  await dialog.getByLabel("Database name").fill("Research");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("research-2");
  // Typing a governed tag is refused by the server's answer, and Create stays off.
  await dialog.getByLabel("Tag for its pages").fill("shared");
  await expect(dialog.getByText("#shared is shared or published")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create database" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Use the name" }).click();
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("research-2");
  // A board without a Status/Select property gets one ADDED (owner decision 2026-10-08), shown before Create.
  const props = dialog.getByRole("list", { name: "Properties of the new database" });
  await dialog.getByRole("button", { name: "Remove Status" }).click();
  await expect(props.getByRole("listitem")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Board" }).check();
  await expect(props.getByRole("listitem")).toHaveCount(1);
  await expect(props).toContainText("To do, In progress, Done · added for the Board view");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  // The board groups by it: it can't be removed while Board is chosen.
  await expect(dialog.getByRole("button", { name: "Remove Status" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Create database" })).toBeEnabled();
  // Another view that does not need it takes the untouched added one away again.
  await dialog.getByRole("radio", { name: "List" }).check();
  await expect(props).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create database" })).toBeEnabled();
});

test("new database: a calendar first view gets a Date property, written with the schema and used by the view", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  const dialog = await openNewDatabase(page);
  await dialog.getByLabel("Database name").fill("Events");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("events");
  const props = dialog.getByRole("list", { name: "Properties of the new database" });
  await dialog.getByRole("radio", { name: "Calendar" }).check();
  await expect(props.getByRole("listitem")).toHaveCount(2);
  await expect(props.getByRole("listitem").last()).toContainText("Date");
  await expect(props.getByRole("listitem").last()).toContainText("added for the Calendar view");
  await expect(dialog.getByRole("button", { name: "Remove Date" })).toBeDisabled();
  // Board needs nothing more (the Status starter serves it); the Date added for the calendar goes.
  await dialog.getByRole("radio", { name: "Board" }).check();
  await expect(props.getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("radio", { name: "Calendar" }).check();
  await expect(props.getByRole("listitem")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  const f = await fx(page);
  expect(Object.keys(f.schemaWrites[0].patch.fields)).toEqual(["status", "date"]);
  expect(f.schemaWrites[0].patch.fields.date).toEqual({ type: "date" });
  expect(f.schemaWrites[0].patch.ui.date).toMatchObject({ kind: "date", label: "Date" });
  const config = f.writes.find((x: any) => x.metadata?.prism_database);
  expect(config.metadata.prism_database.views[0]).toMatchObject({ type: "calendar", dateKey: "date" });
});

test("new database: the tag is refused at create time → the page is taken back; a new tag then succeeds", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  const dialog = await openNewDatabase(page);
  await dialog.getByLabel("Database name").fill("Books");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("books");
  // The tag becomes used between the check and the create (the server's requireNew refuses it).
  await page.evaluate(() => { (window as any).dbFixture.notes().push({ id: "race", path: "X/Race", content: "", tags: ["books"], metadata: {}, createdAt: "", updatedAt: "" }); });
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog.getByRole("alert")).toContainText("#books is already used by pages. Nothing was created.");
  let f = await fx(page);
  expect(f.log).toEqual(["create"]); // the page came first (the refused claim is not logged)…
  expect(f.trashed).toHaveLength(1); // …and was taken back
  expect(f.schemaWrites).toEqual([]);
  // The tag is minted again (books-2) and the retry creates one new page.
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("books-2");
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  f = await fx(page);
  expect(f.schemaWrites.map((w: any) => w.tag)).toEqual(["books-2"]);
  expect(f.log).toEqual(["create", "create", "schema", "config"]);
  await expect(page.getByRole("heading", { name: "No pages yet" })).toBeVisible();
  await expect(page.getByText("#books-2", { exact: true })).toBeVisible();
});

test("new database: a failed view write resumes without a second page or schema write", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page");
  const dialog = await openNewDatabase(page);
  await dialog.getByLabel("Database name").fill("Contacts");
  await expect(dialog.getByLabel("Tag for its pages")).toHaveValue("contacts");
  // The view write is slow, and the page changes meanwhile: the compare-and-set write is refused.
  await page.evaluate(() => { (window as any).dbFixture.slowMs = 400; });
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect.poll(async () => (await fx(page)).log).toEqual(["create", "schema", "config"]);
  await page.evaluate(() => {
    const n = (window as any).dbFixture.notes().find((x: any) => x.path === "Projects/Contacts");
    n.metadata = { ...n.metadata, icon: "📇" };
    n.updatedAt = "2026-10-05T00:00:00.000Z";
    (window as any).dbFixture.slowMs = 0;
  });
  await expect(dialog.getByRole("alert")).toContainText("could not be set up. Try again.");
  await expect(dialog.getByLabel("Tag for its pages")).toBeDisabled(); // the tag is claimed now
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  const f = await fx(page);
  expect(f.log).toEqual(["create", "schema", "config", "config"]); // one page, one schema write
  const stored = await page.evaluate(() => (window as any).dbFixture.notes().find((x: any) => x.path === "Projects/Contacts"));
  expect(stored.metadata.icon).toBe("📇");
  expect(stored.metadata.prism_database.source.tags).toEqual(["contacts"]);
});

test("new database: non-owners are told why and offered an existing tag", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?create&open=page&viewer");
  const dialog = await openNewDatabase(page);
  await expect(dialog.getByRole("note")).toContainText("only the workspace owner can do that");
  await expect(dialog.getByRole("button", { name: "Create database" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use an existing tag" }).click();
  const create = page.getByRole("dialog");
  await create.getByRole("textbox").first().fill("Mine");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Which pages should this database show?" })).toBeVisible();
});
