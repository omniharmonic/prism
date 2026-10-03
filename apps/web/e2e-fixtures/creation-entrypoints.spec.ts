import { test, expect, type Page } from "@playwright/test";
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites);

test("command creation asks for a title, opens the saved page and preserves its parent", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: "A living workspace" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("New Document");
  await search.getByRole("option", { name: "New Document", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await expect(search).toHaveCount(0);
  await expect(create.getByLabel("Page title")).toBeFocused();
  await expect(create.getByRole("button", { name: "Location: Projects / Prism" })).toBeVisible();
  expect(await writes(page)).toEqual([]);
  await create.getByLabel("Page title").fill("A new idea");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename A new idea", exact: true })).toBeVisible();
  expect((await writes(page))[0]).toMatchObject({ path: "Projects/Prism/A new idea", metadata: { type: "document", title: "A new idea" } });
  await page.locator(".tiptap[contenteditable=true]").fill("CREATION_ENTRYPOINT_EDIT");
  await expect.poll(async () => JSON.stringify(await writes(page))).toContain("CREATION_ENTRYPOINT_EDIT");
});

test("folder creation takes its explicit location and cancellation returns to the tree", async ({ page }) => {
  await page.goto("/e2e-fixtures/workspace.html");
  const folder = page.locator(".workspace-navigation").getByRole("button", { name: "Journal", exact: true });
  await folder.click({ button: "right" });
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await expect(create.getByRole("button", { name: "Location: Journal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);
  await expect(folder).toBeFocused();
  expect(await writes(page)).toEqual([]);
  await folder.click({ button: "right" });
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await create.getByLabel("Page title").fill("Daily reflection");
  await create.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rename Daily reflection", exact: true })).toBeVisible();
  expect((await writes(page))[0].path).toBe("Journal/Daily reflection");
});

test("email command preserves draft type without sending and phone cancellation restores search focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  const opener = page.getByRole("button", { name: "Search", exact: true });
  await opener.click();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("New Email");
  await search.getByRole("option", { name: "New Email", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New email draft", exact: true });
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await writes(page)).toEqual([]);
  await opener.click();
  await search.getByRole("combobox").fill("New Email");
  await search.getByRole("option", { name: "New Email", exact: true }).click();
  await create.getByLabel("Page title").fill("Weekly update");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toHaveCount(0);
  expect((await writes(page))[0]).toMatchObject({ path: "Projects/Prism/Weekly update", metadata: { type: "email" } });
});

test("nested mobile page cancellation leaves navigation open and restores its launcher", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const nav = page.getByRole("dialog", { name: "Workspace navigation" });
  // "New page" itself now creates at once (NP-SB-13); the chooser is its neighbour.
  const opener = nav.getByRole("button", { name: "Choose page type", exact: true });
  await opener.click();
  const create = page.getByRole("dialog", { name: "New page", exact: true });
  await expect(create.getByLabel("Page title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);
  await expect(nav).toBeVisible();
  await expect(opener).toBeFocused();
  expect(await writes(page)).toEqual([]);
});
