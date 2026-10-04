import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./browser-compat";
import { focusIndicator } from "./a11y-measure";

/**
 * NP-AX-02 "keyboard-only journey": every journey below is driven with `page.keyboard` ONLY after the
 * page has loaded — no click, hover, focus() or evaluate that moves focus. `page.evaluate` is used to
 * READ state (and, where noted, to seed a fixture before the journey starts).
 *
 * At every stop the focused element must show a focus indicator (an outline or ring; a caret for text
 * fields), Tab must leave every non-modal widget, and Esc must close each menu/dialog and put focus back
 * on the control that opened it.
 */
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]").first();
const ready = (page: Page) => expect(editor(page)).toBeVisible();

class Keys {
  missing: string[] = [];
  stops = 0;
  constructor(private page: Page) {}
  /** Record the focus indicator of whatever has focus now. */
  async stop(where: string) {
    const f = await focusIndicator(this.page);
    this.stops++;
    if (!f.visible) this.missing.push(`${where}: ${f.what} — ${f.detail}`);
  }
  /** Tab (or Shift+Tab) until `target` has focus. Fails when it is not reachable. */
  async tabTo(target: Locator, where: string, opts: { max?: number; back?: boolean } = {}) {
    const max = opts.max ?? 120;
    for (let i = 0; i < max; i++) {
      if (await target.first().evaluate((el) => el === document.activeElement).catch(() => false)) { await this.stop(where); return; }
      await this.page.keyboard.press(opts.back ? "Shift+Tab" : "Tab");
    }
    const at = await focusIndicator(this.page);
    throw new Error(`${where}: not reachable with ${opts.back ? "Shift+" : ""}Tab in ${max} presses (focus ended on ${at.what})`);
  }
  /** Tab must be able to leave `widget` (no keyboard trap). */
  async leaves(widget: Locator, where: string, max = 60) {
    for (let i = 0; i < max; i++) {
      await this.page.keyboard.press("Tab");
      if (!(await widget.first().evaluate((el) => el.contains(document.activeElement)).catch(() => false))) return;
    }
    throw new Error(`${where}: Tab never leaves the widget (${max} presses)`);
  }
  done() { expect(this.missing, "stops with no visible focus indicator").toEqual([]); expect(this.stops).toBeGreaterThan(0); }
}
const focused = (page: Page) => page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return e ? `${e.tagName.toLowerCase()}:${e.getAttribute("aria-label") || e.getAttribute("title") || (e.textContent || "").trim().slice(0, 40)}` : ""; });
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe("keyboard-only journey", () => {
  test("create, format, share, database edit", async ({ page }) => {
    // ── Create a page from the sidebar, title → body, slash block, format, link ──
    await page.goto("/e2e-fixtures/notion-shell.html");
    await ready(page);
    const k = new Keys(page);
    const nav = page.locator(".workspace-navigation");
    await k.tabTo(nav.getByRole("button", { name: "New page", exact: true }), "sidebar New page");
    await page.keyboard.press("Enter");
    const title = page.getByRole("textbox", { name: "Document title" });
    await expect(title).toBeFocused();
    await k.stop("new page title");
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("Keyboard only");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /Keyboard only/ }).or(page.getByRole("button", { name: "Rename Keyboard only" })).first()).toBeVisible();
    // Title Enter lands in the body.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".tiptap"))).toBe(true);
    await k.stop("page body");
    await page.keyboard.type("First line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/head");
    const slash = page.getByRole("listbox", { name: "Insert block" });
    await expect(slash).toBeVisible();
    await k.stop("slash menu (active option)");
    await page.keyboard.press("Enter");
    await expect(slash).toHaveCount(0);
    await page.keyboard.type("A heading");
    await expect(editor(page).locator("h1, h2, h3").filter({ hasText: "A heading" })).toHaveCount(1);
    // Esc on an open slash menu closes it and the caret stays in the text.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(slash).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(slash).toHaveCount(0);
    expect(await page.evaluate(() => !!document.activeElement?.closest(".tiptap"))).toBe(true);
    // …as a caret: that Esc belonged to the menu, it did not also select the block.
    expect(await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.empty)).toBe(true);
    await page.keyboard.press("Backspace");
    // Format + link the word just typed.
    await page.keyboard.type("linked");
    await page.keyboard.press(process.platform === "darwin" ? "Shift+Meta+ArrowLeft" : "Shift+Home");
    // The editor reads the selection on `selectionchange`; a person cannot out-type that, a test can.
    await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; return e.state.doc.textBetween(e.state.selection.from, e.state.selection.to); })).toBe("linked");
    await page.keyboard.press(`${mod}+b`);
    await expect(editor(page).locator("strong, b").filter({ hasText: "linked" })).toHaveCount(1);
    await page.keyboard.press(`${mod}+k`);
    const link = page.getByRole("textbox", { name: /link|url/i }).first();
    await expect(link).toBeFocused();
    await k.stop("link field");
    await page.keyboard.type("https://example.org/a");
    await page.keyboard.press("Enter");
    await expect(editor(page).locator('a[href="https://example.org/a"]')).toHaveCount(1);
    // Tab leaves the editor (no trap): Esc first leaves the text for block selection, then Tab moves on.
    await page.keyboard.press("Escape");
    await k.leaves(editor(page), "editor");

    // ── ⌘K: find a page and open it ──
    await page.keyboard.press(`${mod}+k`);
    const combo = page.getByRole("combobox", { name: "Search notes and commands" });
    await expect(combo).toBeFocused();
    await k.stop("⌘K field");
    await page.keyboard.type("workshop");
    const first = page.getByRole("group", { name: "Notes" }).getByRole("option").first();
    await expect(first).toBeVisible();
    const name = (await first.innerText()).split("\n")[0].trim();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await k.stop("⌘K result (active option)");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Search workspace" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Rename ${name}` }).or(page.getByRole("heading", { name })).first()).toBeVisible();
    k.done();
  });

  test("page ⋯ menu: open, use an item, Esc returns focus", async ({ page }) => {
    await page.goto("/e2e-fixtures/pages-nav.html?open=prism");
    await expect(page.getByRole("heading", { name: "Rename Prism", exact: true }).or(page.getByRole("button", { name: "Rename Prism", exact: true })).first()).toBeVisible();
    const k = new Keys(page);
    const trigger = page.getByRole("button", { name: "Page actions", exact: true });
    await k.tabTo(trigger, "page ⋯ trigger");
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu").last();
    await expect(menu).toBeVisible();
    await expect.poll(() => menu.evaluate((m) => m.contains(document.activeElement))).toBe(true);
    await k.stop("page menu first item");
    await page.keyboard.press("ArrowDown");
    await k.stop("page menu second item");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // Use an item: favorite the page.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Add to Favorites", exact: true })).toBeVisible();
    for (let i = 0; i < 12 && !(await page.getByRole("menuitem", { name: "Add to Favorites", exact: true }).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
    await k.stop("Add to Favorites item");
    await page.keyboard.press("Enter");
    await expect(page.locator(".workspace-navigation").getByRole("region", { name: "Favorites" })).toContainText("Prism");
    k.done();
  });

  test("share dialog: open, move inside, Esc returns focus to Share", async ({ page }) => {
    await page.goto("/e2e-fixtures/sharing.html?page");
    const trigger = page.getByRole("button", { name: "Share fixture", exact: true });
    await expect(trigger).toBeVisible();
    const k = new Keys(page);
    await k.tabTo(trigger, "Share trigger");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Share document" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await k.stop("share dialog first focus");
    // A modal keeps Tab inside; every stop shows focus.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab ${i + 1} stays in the dialog (${await focused(page)})`).toBe(true);
      await k.stop(`share dialog stop ${i + 1}`);
    }
    // Tabs move with arrows.
    await k.tabTo(dialog.getByRole("tab", { selected: true }), "share tabs", { back: true, max: 40 });
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("tab", { name: "Link access", exact: true })).toHaveAttribute("aria-selected", "true");
    await k.stop("share tab after arrow");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    k.done();
  });

  test("live document: comment on a selection", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-mentions.html?comments");
    const body = page.locator(".ProseMirror").first();
    await expect(body).toContainText("The rollout plan is ready");
    const k = new Keys(page);
    await k.tabTo(body, "live editor");
    await page.keyboard.press(`${mod}+ArrowUp`);
    await page.keyboard.press("Home");
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
    const comment = page.getByRole("button", { name: "Comment on selection" });
    await expect(comment).toBeVisible();
    // The selection toolbar is reachable from the text.
    await k.tabTo(comment, "Comment on selection", { max: 30 });
    await page.keyboard.press("Enter");
    const field = page.getByRole("textbox", { name: "Comment" });
    await expect(field).toBeFocused();
    await k.stop("comment composer");
    await page.keyboard.type("Reviewed from the keyboard");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByRole("complementary", { name: "Comments panel" })).toContainText("Reviewed from the keyboard");
    await expect(body.locator("[data-comment-id]")).toHaveCount(1);
    k.done();
  });

  test("database: move between cells, edit, add a row, peek and Esc", async ({ page }) => {
    await page.goto("/e2e-fixtures/databases.html");
    const table = page.getByRole("table", { name: "All tasks" });
    const rowTitle = page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first();
    await expect(rowTitle).toBeVisible();
    const k = new Keys(page);
    await k.tabTo(rowTitle, "row title");
    // Arrow keys move between body cells.
    await page.keyboard.press("ArrowRight");
    await k.stop("cell right of the title");
    const cellA = await focused(page);
    await page.keyboard.press("ArrowDown");
    await k.stop("cell below");
    expect(await focused(page)).not.toBe(cellA);
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toBe(cellA);
    await page.keyboard.press("ArrowLeft");
    await expect(rowTitle).toBeFocused();
    // Edit a cell: Enter opens the editor, Esc returns to the cell.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog], [role=listbox], input, select"))).toBe(true);
    await k.stop("cell editor");
    await page.keyboard.press("Escape");
    await expect.poll(() => focused(page)).toBe(cellA);
    await page.keyboard.press("ArrowLeft");
    // Open the row peek and close it with Esc: focus returns to the row.
    await expect(rowTitle).toBeFocused();
    await page.keyboard.press("Enter");
    const peek = page.getByRole("dialog", { name: /Refine onboarding copy \((side|center) peek\)/ });
    await expect(peek).toBeVisible();
    await expect.poll(() => peek.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await k.stop("row peek first focus");
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await expect(rowTitle).toBeFocused();
    // Add a row.
    const before = await table.locator("tbody tr").count();
    await k.tabTo(page.getByRole("button", { name: "New", exact: true }).first(), "New row");
    await page.keyboard.press("Enter");
    await expect.poll(() => table.locator("tbody tr").count()).toBeGreaterThan(before);
    // Tab leaves the table (no trap).
    await k.tabTo(rowTitle, "row title again", { back: true, max: 200 });
    await k.leaves(table, "database table", 200);
    k.done();
  });

  test("inbox: open an item and archive it", async ({ page }) => {
    const pin = new Date(); pin.setHours(15, 0, 0, 0); await page.clock.setFixedTime(pin);
    await page.goto("/e2e-fixtures/notion-inbox.html?reset&open=notifications");
    const inbox = page.getByTestId("notifications-inbox");
    const rows = inbox.getByTestId("notification-row");
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    const k = new Keys(page);
    const archive = rows.first().getByRole("button", { name: "Archive" });
    await k.tabTo(archive, "inbox Archive");
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(count - 1);
    // Focus is not lost to <body> when its row disappears.
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body && !!document.activeElement)).toBe(true);
    await k.stop("after archive");
    // Open an item.
    const open = rows.first().getByRole("button").first();
    await k.tabTo(open, "inbox row", { back: true, max: 60 }).catch(() => k.tabTo(open, "inbox row", { max: 60 }));
    await page.keyboard.press("Enter");
    await expect(inbox).toHaveCount(0);
    k.done();
  });

  test("settings: change one setting, Esc closes", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    await ready(page);
    const k = new Keys(page);
    const opener = page.getByTitle("Settings", { exact: true });
    await k.tabTo(opener, "sidebar Settings", { max: 200 });
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await k.tabTo(dialog.getByRole("button", { name: "Appearance", exact: true }), "Settings › Appearance", { max: 40 });
    await page.keyboard.press("Enter");
    const reduce = dialog.getByRole("checkbox", { name: "Reduce motion" });
    await k.tabTo(reduce, "Reduce motion", { max: 60 });
    await page.keyboard.press("Space");
    await expect(page.locator("html")).toHaveClass(/reduce-motion/);
    await page.keyboard.press("Space");
    await expect(page.locator("html")).not.toHaveClass(/reduce-motion/);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    k.done();
  });

  test("sidebar tree: arrows move, expand and collapse; Tab leaves", async ({ page }) => {
    await page.goto("/e2e-fixtures/pages-nav.html");
    const tree = page.locator(".workspace-navigation").getByRole("tree", { name: "Pages" });
    const plan = tree.getByRole("button", { name: "Plan", exact: true });
    await expect(plan).toBeVisible();
    const k = new Keys(page);
    await k.tabTo(plan, "tree row Plan", { max: 200 });
    const item = tree.getByRole("treeitem", { name: "Plan", exact: true });
    if ((await item.getAttribute("aria-expanded")) === "true") { await page.keyboard.press("ArrowLeft"); await expect(item).toHaveAttribute("aria-expanded", "false"); }
    await page.keyboard.press("ArrowRight");
    await expect(item).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("button", { name: "Week 1", exact: true })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(tree.getByRole("button", { name: "Week 1", exact: true })).toBeFocused();
    await k.stop("tree row Week 1");
    await page.keyboard.press("ArrowUp");
    await expect(plan).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(item).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("End");
    await k.stop("last tree row");
    await page.keyboard.press("Home");
    await k.stop("first tree row");
    await k.leaves(tree, "page tree", 200);
    k.done();
  });
});

/** Every menu and dialog: opened from the keyboard, closed with Esc, focus back on its opener. */
type Popup = { name: string; path: string; ready?: (page: Page) => Promise<void>; opener: (page: Page) => Locator; open?: string; popup: (page: Page) => Locator; before?: (page: Page) => Promise<void> };
const POPUPS: Popup[] = [
  { name: "page ⋯ menu", path: "/e2e-fixtures/pages-nav.html?open=prism", opener: (p) => p.getByRole("button", { name: "Page actions", exact: true }), popup: (p) => p.getByRole("menu").last() },
  { name: "tree row ⋯ menu", path: "/e2e-fixtures/pages-nav.html", opener: (p) => p.locator(".workspace-navigation").getByRole("button", { name: "Page actions for Plan", exact: true }), popup: (p) => p.getByRole("menu").last() },
  { name: "new page chooser", path: "/e2e-fixtures/pages-nav.html", opener: (p) => p.locator(".workspace-navigation").getByRole("button", { name: "Choose page type" }), popup: (p) => p.getByRole("dialog", { name: /New page|Choose page type/ }) },
  { name: "Trash", path: "/e2e-fixtures/pages-nav.html", opener: (p) => p.locator(".workspace-navigation").getByRole("button", { name: "Trash", exact: true }), popup: (p) => p.getByRole("dialog", { name: "Trash" }) },
  { name: "share dialog", path: "/e2e-fixtures/sharing.html?page", opener: (p) => p.getByRole("button", { name: "Share fixture", exact: true }), popup: (p) => p.getByRole("dialog", { name: "Share document" }) },
  { name: "account menu", path: "/e2e-fixtures/notion-shell.html?account", ready, opener: (p) => p.getByRole("button", { name: "Account menu" }), popup: (p) => p.getByRole("menu", { name: "Account" }) },
  { name: "database filter", path: "/e2e-fixtures/databases.html", opener: (p) => p.getByRole("button", { name: "Filter", exact: true }), popup: (p) => p.getByRole("dialog", { name: "Filter" }) },
  { name: "database sort", path: "/e2e-fixtures/databases.html", opener: (p) => p.getByRole("button", { name: "Sort", exact: true }), popup: (p) => p.getByRole("dialog", { name: "Sort" }) },
  { name: "database view settings", path: "/e2e-fixtures/databases.html", opener: (p) => p.getByRole("button", { name: "View settings" }), popup: (p) => p.getByRole("dialog", { name: "View settings" }) },
  { name: "database column menu", path: "/e2e-fixtures/databases.html", opener: (p) => p.getByRole("button", { name: "Due", exact: true }), popup: (p) => p.getByRole("menu").last() },
  { name: "database more actions", path: "/e2e-fixtures/databases.html", opener: (p) => p.getByRole("button", { name: "More database actions" }), popup: (p) => p.getByRole("menu").last() },
  { name: "history viewer", path: "/e2e-fixtures/context-history.html", opener: (p) => p.locator(".prism-context-history button.prism-context-history-row").first(), popup: (p) => p.getByRole("dialog", { name: "Version history" }) },
  { name: "notification settings", path: "/e2e-fixtures/notion-inbox.html?reset&open=notifications&no-push", opener: (p) => p.getByTestId("notifications-inbox").getByRole("button", { name: "Notification settings" }), popup: (p) => p.getByTestId("notification-settings") },
];

test.describe("Esc closes and focus returns to the opener", () => {
  for (const s of POPUPS) test(s.name, async ({ page }) => {
    await page.goto(s.path);
    await s.ready?.(page);
    const opener = s.opener(page);
    await expect(opener.first()).toBeVisible();
    const k = new Keys(page);
    await k.tabTo(opener, `${s.name} opener`, { max: 250 });
    await page.keyboard.press(s.open ?? "Enter");
    const popup = s.popup(page);
    await expect(popup).toBeVisible();
    // Focus moves into the popup (or stays on an opener that drives it).
    await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await k.stop(`${s.name} first focus`);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(opener.first()).toBeFocused();
    await k.stop(`${s.name} opener after Esc`);
    k.done();
  });

  // Popups opened by a shortcut: focus returns to where it was.
  test("⌘K, shortcut sheet, block menu, find bar, settings", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    await ready(page);
    const k = new Keys(page);
    await k.tabTo(editor(page), "editor", { max: 200 });
    const inEditor = () => page.evaluate(() => !!document.activeElement?.closest(".tiptap"));
    for (const [keys, popup, label] of [
      [`${mod}+k`, page.getByRole("dialog", { name: "Search workspace" }), "⌘K"],
      [`${mod}+/`, page.getByRole("dialog", { name: "Keyboard shortcuts" }), "shortcut sheet"],
      [`${mod}+Shift+/`, page.getByRole("menu", { name: "Block actions" }), "block menu"],
      [`${mod}+f`, page.locator(".prism-find-bar"), "find bar"],
      [`${mod}+,`, page.getByRole("dialog", { name: "Settings", exact: true }), "settings"],
    ] as Array<[string, Locator, string]>) {
      await page.keyboard.press(keys);
      await expect(popup, label).toBeVisible();
      await expect.poll(() => popup.evaluate((el) => el.contains(document.activeElement)), label).toBe(true);
      await k.stop(`${label} first focus`);
      await page.keyboard.press("Escape");
      await expect(popup, label).toBeHidden();
      await expect.poll(inEditor, `${label}: focus back in the editor`).toBe(true);
    }
    k.done();
  });
});
