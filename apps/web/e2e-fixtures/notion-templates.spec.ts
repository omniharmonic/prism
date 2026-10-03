import { test, expect } from "@playwright/test";
import { transferUrl, serveAttachments, shot } from "./transfer-helpers";

/** NP-TX-02 — template variables resolve when a page is created from the template. */
const nav = (page: import("@playwright/test").Page) => page.locator(".workspace-navigation").first();
test.beforeEach(async ({ page }) => { await serveAttachments(page); });
const writes = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, any>>);

test("date variables resolve on create", async ({ page }) => {
  const at = new Date(2026, 9, 3, 15, 30, 0); // 3 Oct 2026, 15:30 local
  await page.clock.setFixedTime(at);
  await page.goto(transferUrl());
  await nav(page).getByRole("button", { name: "New page from template", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await create.getByRole("group", { name: "Templates" }).getByRole("button", { name: "Daily log" }).click();
  await create.getByLabel("Page title").fill("Friday @today");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Friday @today", exact: true })).toBeVisible();

  const created = (await writes(page)).find((w) => w.create)!.create as Record<string, any>;
  // Properties: a value that IS a variable becomes the stored value of that kind.
  expect(created.metadata).toMatchObject({ title: "Friday @today", date: "2026-10-03", started: at.toISOString(), author: "You", status: "open" });
  expect(created.tags).toEqual(["journal"]);
  // Body: @today / @now become date chips, @me the creator's name — once, at creation.
  expect(created.content).toContain('<h2>Log for <span data-type="mention" data-kind="date" data-date="2026-10-03"');
  expect(created.content).toContain(`data-date="${at.toISOString()}"`);
  expect(created.content).toContain("by You.</p>");
  // An address and code are not variables.
  expect(created.content).toContain("Mail me@today.example or use <code>@today</code> literally.");
  expect(created.content).not.toMatch(/Log for @today|Started @now|by @me/);

  // The open page shows the resolved values (two date chips, the name, the literal code).
  const doc = page.locator(".tiptap");
  await expect(doc.locator('[data-type="mention"][data-kind="date"]')).toHaveCount(2);
  await expect(doc.locator('[data-type="mention"][data-kind="date"]').first()).toHaveText(/Today|Oct(ober)? 3|2026-10-03/);
  await expect(doc).toContainText("by You.");
  await expect(doc.locator("code")).toHaveText("@today");

  // The template itself is untouched: the next page made from it resolves afresh.
  const template = await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "tpl-daily"));
  expect(template.content).toContain("<h2>Log for @today</h2>");
  expect(template.metadata.date).toBe("@today");
});

test("a template without variables is copied as it is", async ({ page }) => {
  await page.goto(transferUrl());
  await nav(page).getByRole("button", { name: "New page from template", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await create.getByRole("group", { name: "Templates" }).getByRole("button", { name: "Meeting notes" }).click();
  await create.getByLabel("Page title").fill("Sync");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Sync", exact: true })).toBeVisible();
  const created = (await writes(page)).find((w) => w.create)!.create as Record<string, any>;
  const template = await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "tpl-meeting"));
  expect(created.content).toBe(template.content);
  expect(created.metadata).toMatchObject({ title: "Sync", status: "draft" });
});

// ── NP-TX-01: "Save as template" + the Templates gallery ─────────────────────
type P = import("@playwright/test").Page;
const gallery = (page: P) => page.getByRole("dialog", { name: "Templates", exact: true });
const openGallery = async (page: P) => {
  await nav(page).getByRole("region", { name: "Pages", exact: true }).waitFor();
  await page.evaluate(() => (window as any).prismTransfer.pages.getState().openTemplates(true));
  await expect(gallery(page)).toBeVisible();
};
const pageMenu = async (page: P) => {
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  return page.getByRole("menu");
};

test("save page as template", async ({ page }) => {
  await page.goto(transferUrl("?open=prism"));
  await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
  await (await pageMenu(page)).getByRole("menuitem", { name: "Save as template", exact: true }).click();
  const toast = page.locator(".page-toast");
  await expect(toast).toContainText("Saved “Prism” as a template");

  const all = await writes(page);
  const created = all.find((w) => w.create)!.create as Record<string, any>;
  // The template is a note tagged `template` (what the chooser and the gallery read), in Templates/.
  expect(created.path).toBe("Templates/Prism");
  expect(created.tags).toEqual(["page", "template"]);
  // Body and properties come along; identity never does.
  expect(created.content).toContain("<h2>About</h2>");
  expect(created.content).toContain('src="/api/attachments/a_fixtureImage0000000001"');
  expect(created.metadata).toMatchObject({ title: "Prism", status: "active", type: "document" });
  // (`prism_client_op` is the transport's own idempotency stamp on every create.)
  expect(Object.keys(created.metadata).filter((k) => k.startsWith("prism_"))).toEqual(["prism_client_op"]);
  // The template gets its OWN copies of the page's files.
  const template = (await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.path === "Templates/Prism"))) as { id: string };
  expect(all.filter((w) => w.copyAttachments)).toEqual([{ copyAttachments: template.id }]);
  // The original page is untouched.
  const original = await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "prism"));
  expect(original.tags).toEqual(["page"]);
  expect(original.metadata.prism_creator).toBe("owner@example.test");

  // It appears in the gallery (the toast's action opens it)…
  await toast.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(gallery(page).getByRole("listitem", { name: "Prism", exact: true })).toBeVisible();
  await expect(gallery(page).getByRole("listitem")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(gallery(page)).toHaveCount(0);
  // …and in the New page chooser.
  await nav(page).getByRole("button", { name: "New page from template", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await expect(create.getByRole("group", { name: "Templates" }).getByRole("button", { name: "Prism", exact: true })).toBeVisible();
  // The chooser hands over to the gallery.
  await create.getByRole("group", { name: "Templates" }).getByRole("button", { name: "Manage templates…" }).click();
  await expect(create).toHaveCount(0);
  await expect(gallery(page)).toBeVisible();
});

test("a page saved as a template can be used: its files are copied to the new page", async ({ page }) => {
  await page.goto(transferUrl("?open=prism"));
  await (await pageMenu(page)).getByRole("menuitem", { name: "Save as template", exact: true }).click();
  await expect(page.locator(".page-toast")).toContainText("as a template");
  await openGallery(page);
  await gallery(page).getByRole("button", { name: "Use Prism", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  // The chooser opens with the template already picked.
  await expect(create.getByRole("button", { name: "Prism", exact: true })).toBeVisible();
  await create.getByLabel("Page title").fill("Launch notes");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Launch notes", exact: true })).toBeVisible();
  const all = await writes(page);
  const made = all.filter((w) => w.create).map((w) => w.create as Record<string, any>);
  expect(made).toHaveLength(2);
  expect(made[1]!.metadata).toMatchObject({ title: "Launch notes", status: "active" });
  expect(made[1]!.tags).toEqual(["page"]); // `template` is not carried into the page
  expect(made[1]!.content).toContain("/api/attachments/");
  const page2 = (await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.metadata?.title === "Launch notes"))) as { id: string };
  expect(all.filter((w) => w.copyAttachments).map((w) => w.copyAttachments)).toContain(page2.id);
});

test("gallery Use resolves the template's variables", async ({ page }) => {
  const at = new Date(2026, 9, 3, 15, 30, 0);
  await page.clock.setFixedTime(at);
  await page.goto(transferUrl());
  await runCommandTemplates(page);
  await gallery(page).getByRole("button", { name: "Use Daily log", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await create.getByLabel("Page title").fill("Saturday");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Saturday", exact: true })).toBeVisible();
  const created = (await writes(page)).find((w) => w.create)!.create as Record<string, any>;
  expect(created.metadata).toMatchObject({ title: "Saturday", date: "2026-10-03", author: "You" });
  expect(created.content).toContain('data-kind="date" data-date="2026-10-03"');
  expect(created.content).not.toMatch(/Log for @today|by @me/);
});

/** The command bar's "Templates" entry. */
async function runCommandTemplates(page: P) {
  await nav(page).getByRole("region", { name: "Pages", exact: true }).waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("Templates");
  await search.getByRole("option", { name: "Templates", exact: true }).click();
  await expect(gallery(page)).toBeVisible();
}

test("gallery lists templates; edit, rename and delete with undo; keyboard", async ({ page }) => {
  await page.goto(transferUrl());
  const trigger = nav(page).getByRole("button", { name: "New page from template", exact: true });
  await trigger.click();
  await page.getByRole("dialog", { name: "New page", exact: true }).getByRole("button", { name: "Manage templates…" }).click();
  const g = gallery(page);
  const rows = g.getByRole("listitem");
  // Name + edited date for each template the viewer can see, in name order.
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Daily log");
  await expect(rows.nth(0)).toContainText(/Edited .*2026/);
  await expect(rows.nth(1)).toContainText("Meeting notes");

  // Keyboard: arrows move between templates and keep the same action; Tab stays inside (a modal dialog).
  await g.getByRole("button", { name: "Use Daily log", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(g.getByRole("button", { name: "Use Meeting notes", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(g.getByRole("button", { name: "Use Task", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(g.getByRole("button", { name: "Use Daily log", exact: true })).toBeFocused();

  // Rename: the name people see changes (title) and the file follows.
  await g.getByRole("button", { name: "Rename Task", exact: true }).click();
  const field = g.getByRole("textbox", { name: "New name for Task" });
  await expect(field).toBeFocused();
  await field.fill("Chore");
  await field.press("Enter");
  await expect(g.getByRole("listitem", { name: "Chore", exact: true })).toBeVisible();
  await expect(g.getByRole("status")).toContainText("Renamed to “Chore”.");
  const renamed = await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "tpl-task"));
  expect(renamed.metadata.title).toBe("Chore");
  expect(renamed.path).toBe("_templates/Chore");
  expect(renamed.tags).toContain("template");

  // Delete = a move to the Trash, with Undo in the dialog.
  await g.getByRole("button", { name: "Delete Project brief", exact: true }).click();
  await expect(g.getByRole("status")).toContainText("Moved “Project brief” to Trash.");
  await expect(rows).toHaveCount(3);
  expect((await writes(page)).some((w) => w.trash === "tpl-brief")).toBe(true);
  await g.getByRole("status").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(g.getByRole("status")).toContainText("Restored “Project brief”.");
  await expect(rows).toHaveCount(4);
  const restored = await page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "tpl-brief"));
  expect(restored.tags).not.toContain("prism-trashed");

  // Edit opens the template itself as a page.
  await g.getByRole("button", { name: "Edit Meeting notes", exact: true }).click();
  await expect(g).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Rename Meeting notes", exact: true })).toBeVisible();
  // A template has no "Save as template" of its own.
  await expect((await pageMenu(page)).getByRole("menuitem", { name: "Save as template" })).toHaveCount(0);
});

test("a deleted template can still be restored after the gallery closes", async ({ page }) => {
  await page.goto(transferUrl());
  await openGallery(page);
  await gallery(page).getByRole("button", { name: "Delete Task", exact: true }).click();
  await expect(gallery(page).getByRole("status")).toContainText("Moved “Task” to Trash.");
  await page.keyboard.press("Escape");
  const toast = page.locator(".page-toast");
  await expect(toast).toContainText("Moved “Task” to Trash");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "tpl-task").tags.includes("prism-trashed"))).toBe(false);
});

test("empty gallery says how to make a template; focus returns on close", async ({ page }) => {
  await page.goto(transferUrl());
  await nav(page).getByRole("region", { name: "Pages", exact: true }).waitFor();
  await page.evaluate(() => { for (const n of (window as any).prismFixtureNotes) n.tags = n.tags.filter((t: string) => t !== "template"); });
  const opener = nav(page).getByRole("button", { name: "New page from template", exact: true });
  await opener.focus();
  await openGallery(page);
  await expect(gallery(page)).toContainText("No templates yet");
  await expect(gallery(page)).toContainText("Save as template");
  await expect(gallery(page).getByRole("listitem")).toHaveCount(0);
  // Focus starts inside the dialog and returns to where it was on close.
  expect(await gallery(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(gallery(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("permissions: a view-only reader and a guest have no Save as template", async ({ page }) => {
  await page.goto(transferUrl("?open=prism&viewer"));
  await expect(page.getByRole("heading", { name: "Prism" })).toBeVisible();
  const menu = await pageMenu(page);
  await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Save as template" })).toHaveCount(0);

  await page.goto(transferUrl("?open=prism&guest"));
  await expect(page.getByRole("heading", { name: "Prism" })).toBeVisible();
  const guestMenu = await pageMenu(page);
  await expect(guestMenu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
  await expect(guestMenu.getByRole("menuitem", { name: "Save as template" })).toHaveCount(0);
});

for (const theme of ["", "&dark"]) {
  test(`phone${theme ? " (dark)" : ""}: Save as template from the page sheet, gallery full screen with reachable actions`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(transferUrl(`?open=prism${theme}`));
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("button", { name: "Save as template", exact: true }).click();
    await expect(page.locator(".page-toast")).toContainText("Saved “Prism” as a template");
    await page.evaluate(() => (window as any).prismTransfer.pages.getState().openTemplates(true));
    const g = gallery(page);
    await expect(g).toBeVisible();
    const box = (await g.boundingBox())!;
    expect(box.width).toBe(390);
    expect(box.height).toBe(844);
    // No sideways scrolling, and every action is a 44 px target.
    expect(await g.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const name of ["Use Prism", "Edit Prism", "Rename Prism", "Delete Prism"]) {
      const b = (await g.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    // Readable in this theme: the row text is not the dialog's background colour.
    const colours = await g.getByRole("listitem", { name: "Prism", exact: true }).evaluate((el) => {
      const dialog = el.closest("dialog")!;
      return { text: getComputedStyle(el.querySelector(".label")!).color, bg: getComputedStyle(dialog).backgroundColor };
    });
    expect(colours.text).not.toBe(colours.bg);
    await shot(page, `templates-gallery-phone${theme ? "-dark" : ""}`);
  });
}
