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

/**
 * NP-PG-06, the clause that was a deviation: the header bar SHOWS THE BREADCRUMB — in the bar's one row, beside
 * save state / star / Share / ⋯ / Agent (not above the title, and not twice). Ancestors are clickable and in the
 * tab order, middle segments sit behind a “…” menu, page ancestors carry their icon; it gives way as the window
 * narrows and never pushes the row wider than the window (1440, 1024, 768, 390). Phone: the page's name is the
 * control (with Back beside it) and lists the trail.
 */
test("NP-PG-06: the breadcrumb is in the header bar — one row, overflow menu, icons, keyboard, every width", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const ui = () => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId as string; });
  const strip = page.getByRole("navigation", { name: "Open document tabs" });
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  const share = page.getByRole("button", { name: "Share", exact: true });

  // The page in front ("Projects/Prism/A living workspace"): its trail is in the bar, once, and not above the title.
  await expect(crumbs).toHaveCount(1);
  expect(await crumbs.evaluate((el) => !!el.closest('[aria-label="Open document tabs"]'))).toBe(true);
  await expect(crumbs.getByRole("button")).toHaveText(["Projects", "Prism"]);
  await expect(page.locator(".document-page-header .document-breadcrumb")).toHaveCount(0);
  // One quiet row: the trail, the tab's own name and every header action share a centre line.
  const row = [crumbs, strip.getByRole("button", { name: "Open A living workspace", exact: true }), page.locator(".sync-state-header"), page.getByRole("button", { name: "Add to Favorites" }), share,
    page.getByRole("button", { name: "Page actions", exact: true }), page.getByRole("button", { name: "AI Agent", exact: true })];
  const boxes = await Promise.all(row.map((l) => l.boundingBox()));
  const centre = boxes[4]!.y + boxes[4]!.height / 2;
  for (const b of boxes) expect(Math.abs(b!.y + b!.height / 2 - centre)).toBeLessThanOrEqual(3);
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1); // the trail leads into the page's name

  // A deep page: first · … · last two; the page ancestor carries its icon and opens; the menu holds the middle.
  await page.evaluate(() => {
    const w = window as any;
    w.prismShell.serverCreate("Projects/Prism/A living workspace/Decisions/Budget", "<p>Numbers.</p>");
    w.prismShellUI.getState().openTab("foreign-1", "Budget", "document");
  });
  await expect(crumbs.getByRole("button")).toHaveText(["Projects", "", "A living workspace", "Decisions"]);
  await expect(crumbs.getByRole("button", { name: "A living workspace" })).toHaveAttribute("title", "Open A living workspace");
  await expect(crumbs.getByRole("button", { name: "Decisions" })).toHaveAttribute("title", "Show Decisions in the sidebar");
  await expect(page.locator(".document-page-header .document-breadcrumb")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("header-breadcrumb-1440.png") });
  // Keyboard only: the “…” button opens the menu of hidden ancestors; Escape closes it.
  const more = crumbs.getByRole("button", { name: "Show 1 more location" });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "More locations" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Prism"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // …and a page ancestor opens from the keyboard.
  await crumbs.getByRole("button", { name: "A living workspace" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(ui).toBe("workspace");
  await expect(crumbs.getByRole("button")).toHaveText(["Projects", "Prism"]);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("foreign-1", "Budget", "document"));
  await expect(crumbs.getByRole("button", { name: "Decisions" })).toBeVisible();

  // Narrower windows: the bar never outgrows the window, every action stays on screen, and the trail stays
  // reachable (whole, shortened, or as its “…” menu).
  for (const width of [1440, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(crumbs).toHaveCount(1);
    // The trail is never why the tab strip scrolls: where the tabs do not fit, it has already folded into its menu.
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 || el.querySelector(".tabbar-crumbs")?.getAttribute("data-room") === "menu"), { message: `the trail gives way at ${width}` }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}`).toBe(true);
    expect(await crumbs.getByRole("button").count(), `the trail is reachable at ${width}`).toBeGreaterThan(0);
    for (const l of [page.locator(".sync-state-header"), page.getByRole("button", { name: "Add to Favorites" }), share, page.getByRole("button", { name: "Page actions", exact: true }), page.getByRole("button", { name: "AI Agent", exact: true })]) {
      const b = (await l.boundingBox())!;
      expect(b.x >= 0 && b.x + b.width <= width, `header action inside the window at ${width}`).toBe(true);
    }
  }
  // With no room for names the whole trail is one menu.
  await page.evaluate(() => { const st = (window as any).prismShellUI.getState(); for (const [id, title] of [["agenda", "Workshop agenda"], ["field-notes", "Field notes"], ["blank", "Untitled"], ["tracker", "Workshop tracker"]]) st.openTab(id, title, "document"); st.openTab("foreign-1", "Budget", "document"); });
  const all = crumbs.getByRole("button", { name: "Show 4 locations" });
  await expect(all).toBeVisible();
  await all.click();
  await expect(page.getByRole("menu", { name: "More locations" }).getByRole("menuitem")).toHaveText(["Projects", "Prism", "A living workspace", "Decisions"]);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("header-breadcrumb-768.png") });

  // Phone: the page's name with Back beside it; the name lists the trail; nothing overflows; the row's other parts stay.
  await page.setViewportSize({ width: 390, height: 844 });
  const where = crumbs.getByRole("button", { name: "Budget — show 4 locations" });
  await expect(where).toBeVisible();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(page.locator(".sync-state-phone .sync-state-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Page actions", exact: true })).toBeVisible();
  expect((await where.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".document-page-header .document-breadcrumb")).toHaveCount(0);
  await where.click();
  const trail = page.getByRole("menu", { name: "Locations" });
  await expect(trail.getByRole("menuitem")).toHaveText(["Projects", "Prism", "A living workspace", "Decisions"]);
  await page.screenshot({ path: info.outputPath("header-breadcrumb-390.png") });
  await trail.getByRole("menuitem", { name: "A living workspace" }).click();
  await expect.poll(ui).toBe("workspace");
  await expect(crumbs.getByRole("button", { name: "A living workspace — show 2 locations" })).toBeVisible();
});

/** NP-PG-06 × NP-AX-07: on a WIDE touch screen (a tablet: coarse pointer, no hover) every crumb in the bar is a 44 px target. */
test("NP-PG-06: header-bar crumbs are 44 px targets on a wide coarse-pointer screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.prismShell.serverCreate("Projects/Prism/A living workspace/Decisions/Budget", "<p>Numbers.</p>");
    w.prismShellUI.getState().openTab("foreign-1", "Budget", "document");
  });
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(crumbs.getByRole("button").first()).toBeVisible();
  await expect.poll(() => crumbs.getByRole("button").count()).toBeGreaterThan(0);
  const sizes = await crumbs.getByRole("button").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") ?? el.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }));
  for (const s of sizes) expect(s.w >= 44 && s.h >= 44, `${s.name}: ${s.w}×${s.h}`).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Folded to its “…” menu (many tabs), that one button is a 44 px target too.
  await page.evaluate(() => { const st = (window as any).prismShellUI.getState(); for (const [id, title] of [["agenda", "Workshop agenda"], ["field-notes", "Field notes"], ["blank", "Untitled"], ["tracker", "Workshop tracker"]]) st.openTab(id, title, "document"); st.openTab("foreign-1", "Budget", "document"); });
  const all = crumbs.getByRole("button", { name: /^Show \d+ (more )?locations?$/ }).first();
  await expect(all).toBeVisible();
  const box = (await all.boundingBox())!;
  expect(box.width >= 44 && box.height >= 44, `… ${box.width}×${box.height}`).toBe(true);
  await context.close();
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

/** NP-PG-03 */
test("Enter in the title moves into the body", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Rename A living workspace", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("A living plan");
  await title.press("Enter");
  // The rename is committed and typing continues in the page, no click needed.
  await expect(editor).toBeFocused();
  await expect(page.getByRole("button", { name: "Rename A living plan", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismShell.note("workspace").path)).toBe("Projects/Prism/A living plan");
  await page.keyboard.type("Typed straight after the title. ");
  await expect(editor).toContainText("Typed straight after the title.");
  // Unchanged title + Enter also lands in the body; Esc and blur do not move focus there.
  await page.getByRole("button", { name: "Rename A living plan", exact: true }).click();
  await title.press("Enter");
  await expect(editor).toBeFocused();
  await page.getByRole("button", { name: "Rename A living plan", exact: true }).click();
  await title.press("Escape");
  await expect(editor).not.toBeFocused();
  // A new page: name it, Enter, write.
  await page.locator(".workspace-navigation").getByRole("button", { name: "New page", exact: true }).click();
  await expect(title).toBeFocused();
  await title.fill("Sprint notes");
  await title.press("Enter");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeFocused();
});

/** NP-PG-01 */
test("icon propagates to tree, tabs, ⌘K", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const nav = page.locator(".workspace-navigation");
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  await expect(tabs.locator("[data-page-icon]")).toHaveCount(0);
  await page.getByRole("button", { name: "Add icon" }).click();
  const picker = page.locator(".EmojiPickerReact");
  await expect(picker).toBeVisible();
  await picker.locator("button.epr-emoji:visible").first().click();
  const tile = page.locator(".document-icon-control.has-icon");
  await expect(tile).toBeVisible();
  const emoji = (await tile.innerText()).trim();
  expect(emoji.length).toBeGreaterThan(0);
  // Tab, sidebar tree and (once starred) Favorites show it at once — no reload.
  await expect(tabs.locator('[data-page-icon="workspace"]')).toHaveText(emoji);
  await expect(nav.getByRole("region", { name: "Pages", exact: true })).toContainText(emoji);
  await page.getByRole("button", { name: "Add to Favorites" }).click();
  await expect(nav.locator('[data-page-icon="workspace"]').first()).toHaveText(emoji);
  expect(await page.evaluate(() => (window as any).prismShell.note("workspace").metadata.icon)).toBe(emoji);
  // ⌘K results.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("living");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /A living workspace/ }).first()).toContainText(emoji);
  await page.keyboard.press("Escape");
  // Breadcrumbs of a sub-page show the parent page's icon.
  await page.evaluate(() => {
    const shell = (window as any).prismShell;
    shell.serverCreate("Projects/Prism/A living workspace/Decisions", "<p>Decided.</p>");
    (window as any).prismShellUI.getState().openTab("foreign-1", "Decisions", "document");
  });
  const crumbs = page.getByRole("navigation", { name: "Document location" });
  await expect(crumbs.locator('[data-page-icon="workspace"]')).toHaveText(emoji);
  // "Another device": a fresh load reads the icon from the server's tree.
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Open document tabs" }).locator('[data-page-icon="workspace"]')).toHaveText(emoji);
});
