import { test, expect } from "@playwright/test";

/** Wave 2E · NP-PG-06: one quiet header row with save state and labelled actions. */
test("header carries save state, Share, Agent, ⋯", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const saved = page.locator(".sync-state-header");
  const share = page.getByRole("button", { name: "Share", exact: true });
  const agent = page.getByRole("button", { name: "AI Agent", exact: true });
  const more = page.getByRole("button", { name: "Page actions", exact: true });
  const star = page.getByRole("button", { name: "Add to Favorites" });
  await expect(saved).toHaveText("Saved");
  await expect(share).toHaveText("Share");
  await expect(agent).toHaveText("Agent");
  await expect(more).toBeVisible();
  await expect(star).toBeVisible();
  const boxes = await Promise.all([saved, share, agent, more, star].map((l) => l.boundingBox()));
  const centre = boxes[0]!.y + boxes[0]!.height / 2;
  for (const b of boxes) expect(Math.abs(b!.y + b!.height / 2 - centre)).toBeLessThanOrEqual(3);
  await agent.click();
  await expect(page.getByLabel("Document companion")).toBeVisible();
  await page.screenshot({ path: info.outputPath("header-desktop.png") });
  await page.evaluate(() => { document.documentElement.classList.replace("light", "dark"); });
  await page.screenshot({ path: info.outputPath("header-desktop-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sync-state-phone")).toHaveAttribute("data-sync-state", "saved");
  await expect(page.locator(".sync-state-phone .sync-state-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Page actions", exact: true })).toBeVisible();
  await expect(page.getByText("A living workspace").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("header-phone-dark.png") });
});

/** Wave 2E · NP-PG-08 */
test("full width, small text, font persist per page", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  const main = page.locator("#workspace-document");
  const measure = () => page.locator(".prose-editor").first().evaluate((n) => n.getBoundingClientRect().width);
  const narrow = await measure();
  const menu = () => page.getByRole("button", { name: "Page actions", exact: true }).click();
  await menu();
  await page.getByRole("menuitem", { name: /Full width/ }).click();
  await expect(main).toHaveAttribute("data-page-full", "true");
  expect(await measure()).toBeGreaterThan(narrow + 40);
  await menu();
  await page.getByRole("menuitem", { name: /Small text/ }).click();
  await expect(main).toHaveAttribute("data-page-small", "true");
  await menu();
  await page.getByRole("menuitem", { name: /Serif font/ }).click();
  await expect(page.locator("[data-content-font=serif]").first()).toBeVisible();
  // Style writes are metadata-only and never touch the body.
  const writes = await page.evaluate(() => (window as any).prismShell.writes as Array<{ path: string; body: any }>);
  expect(writes.filter((w) => w.path.endsWith("/meta")).every((w) => !("content" in w.body) && w.body.set.prism_page_style)).toBe(true);
  expect(writes.some((w) => "content" in w.body)).toBe(false);
  await page.screenshot({ path: info.outputPath("page-style-desktop.png") });
  // Another device (a fresh page) honours the stored style.
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(main).toHaveAttribute("data-page-full", "true");
  await expect(main).toHaveAttribute("data-page-small", "true");
  await expect(page.locator("[data-content-font=serif]").first()).toBeVisible();
  // Turning one flag off keeps the other.
  await menu();
  await page.getByRole("menuitem", { name: /Full width/ }).click();
  await expect(main).not.toHaveAttribute("data-page-full", "true");
  await expect(main).toHaveAttribute("data-page-small", "true");
  // Other pages keep their own style.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await expect(main).not.toHaveAttribute("data-page-small", "true");
});

/** Wave 2E · NP-PG-10 */
test("backlinks pill lists linking pages", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const pill = page.getByRole("button", { name: "2 backlinks" });
  await expect(pill).toBeVisible(); // the hidden page is never counted
  await pill.click();
  const list = page.getByRole("region", { name: "Pages that link here" });
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(list).toContainText("Workshop agenda");
  await expect(list).toContainText("See A living workspace for the plan.");
  await expect(list).not.toContainText("hidden-page");
  await page.screenshot({ path: info.outputPath("backlinks-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(pill).toBeFocused();
  await pill.click();
  await list.getByRole("button", { name: /Field notes/ }).click();
  await expect(page.getByText("Notes from the last conversation")).toBeVisible();
  // A page nobody links to has no pill.
  await expect(page.getByRole("button", { name: /backlinks?$/ })).toHaveCount(0);
});

/** Wave 2E · NP-PG-14 */
test("empty page starters vanish on typing", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const starters = page.getByRole("group", { name: "Start this page" });
  await expect(starters).toHaveCount(0); // a page with content never shows them
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("blank", "Untitled", "document"));
  await expect(starters).toBeVisible();
  for (const name of ["Empty page", "Template", "Import"]) await expect(starters.getByRole("button", { name })).toBeVisible();
  await page.screenshot({ path: info.outputPath("empty-starters.png") });
  // Template fills this page (the editor then autosaves as usual).
  await starters.getByRole("button", { name: "Template" }).click();
  await page.getByRole("list", { name: "Templates" }).getByRole("button", { name: "Meeting notes" }).click();
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor.locator("h2")).toHaveText("Agenda");
  await expect(starters).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => (window as any).prismShell.writes)).some((w: any) => w.path.endsWith("/blank") && String(w.body.content).includes("Agenda")), { timeout: 8000 }).toBe(true);
  // Undo back to empty brings them back; typing removes them again.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(starters).toBeVisible();
  await starters.getByRole("button", { name: "Empty page" }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hello");
  await expect(starters).toHaveCount(0);
  // Import a Markdown file into an empty page.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(starters).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await starters.getByRole("button", { name: "Import" }).click();
  await (await chooser).setFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported\n\n- one\n- two\n<script>window.bad = 1</script>") });
  await expect(editor.locator("h1")).toHaveText("Imported");
  await expect(editor.locator("li")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).bad)).toBeUndefined();
});

// ── wave 2D ──────────────────────────────────────────────────────────────────
/** NP-PG-17 — the page ⋯ menu's info footer (standalone component; 2B's chrome mounts it). */

const shots = "/private/tmp/claude-501/-Users-benjaminlife-dev-prism/94600911-66b9-4b8d-b802-fc8f8fe9305f/scratchpad/w2-sharing";

test("page info footer", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=info");
  const dl = page.locator("dl.prism-page-info");
  await expect(dl).toBeVisible();
  const value = (label: string) => dl.locator("div", { has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
  // "Research handbook" + "A shared workspace where you and your agent work with connected context." + "Prism brings notes, tasks and sources together."
  await expect(value("Word count")).toHaveText("21");
  await expect(value("Characters")).toHaveText(String("Research handbookA shared workspace where you and your agent work with connected context.Prism brings notes, tasks and sources together.".length));
  await expect(value("Created")).toContainText("Sep 1");
  await expect(value("Last edited")).not.toHaveText("");
  await expect(value("Last edited by")).toHaveText("You");
  await page.screenshot({ path: `${shots}/page-info.png` });
});
