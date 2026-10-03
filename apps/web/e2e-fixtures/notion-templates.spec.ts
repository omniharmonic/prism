import { test, expect } from "@playwright/test";
import { transferUrl, serveAttachments } from "./transfer-helpers";

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
