/**
 * NP-AX sweep: every primary surface, how to get it open in the fixtures, and what "open" looks like.
 * Shared by the axe sweep, the dark-mode sweep and the touch-target sweep in `notion-a11y.spec.ts`.
 * Recipes are the ones the feature specs use (kept short; a recipe change there usually means one here).
 */
import { expect, type Page } from "@playwright/test";

export type Viewport = "desktop" | "phone";
export type Theme = "light" | "dark";
export const VIEWPORTS: Record<Viewport, { width: number; height: number }> = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

export type Surface = {
  id: string;
  path: string;
  /** Default: both. */
  only?: Viewport;
  /** Runs before navigation (clock pins, routes, init scripts). */
  before?: (page: Page) => Promise<void>;
  /** Gets the surface open; must end with an assertion that it is visible. */
  open: (page: Page, vp: Viewport) => Promise<void>;
};

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const serveAttachments = (page: Page) => page.route("**/api/attachments/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
const pinClock = async (page: Page) => { const pin = new Date(); pin.setHours(15, 0, 0, 0); await page.clock.setFixedTime(pin); };
const editorReady = (page: Page) => expect(page.locator(".tiptap[contenteditable=true]").first()).toBeVisible();
const dbReady = (page: Page) => expect(page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first()).toBeVisible();
const dbRow = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const treeReady = (page: Page) => nav(page).getByRole("region", { name: "Pages", exact: true }).waitFor();
/** The phone Browse drawer (the sidebar lives in it at 390 px). */
async function drawer(page: Page) {
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(d).toBeVisible();
  return d;
}
async function selectBravo(page: Page) {
  await editorReady(page);
  // A scripted DOM selection made within ~20 ms of the editor gaining focus is undone by
  // ProseMirror's post-focus re-sync (see `select` in editor-toolbar.spec.ts): make it until it holds.
  const target = page.getByText("Bravo paragraph", { exact: true });
  await expect(async () => {
    await target.click();
    await target.selectText();
    await expect.poll(() => page.evaluate(() => { const e = (document.querySelector(".tiptap") as any).editor; const { from, to } = e.state.selection; return e.state.doc.textBetween(from, to) as string; }), { timeout: 1000 }).toBe("Bravo paragraph");
  }).toPass({ timeout: 10_000 });
  const bubble = page.locator(".document-selection-actions:visible, .cd-bubble:visible").first();
  await expect(bubble).toBeVisible();
  return bubble;
}
async function blockMenu(page: Page, vp: Viewport) {
  await editorReady(page);
  await page.getByText("Bravo paragraph", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe("Bravo paragraph");
  if (vp === "phone") await page.getByRole("button", { name: "Block actions" }).click();
  else await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("menu", { name: "Block actions" })).toBeVisible();
}
async function command(page: Page, name: string) {
  await treeReady(page).catch(() => {});
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill(name);
  await search.getByRole("option", { name }).first().click();
}
async function shareDialog(page: Page, tab?: string) {
  await page.getByRole("button", { name: "Share fixture", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share document" });
  await expect(dialog).toBeVisible();
  if (tab) { await page.getByRole("tab", { name: tab, exact: true }).click(); await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true"); }
}
async function settings(page: Page, section: string) {
  await page.waitForFunction(() => !!(window as any).prismFixtureUI);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().setSettingsOpen(true));
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: section, exact: true }).click();
}
async function dbView(page: Page, tab: string) {
  await dbReady(page);
  await page.getByRole("tab", { name: tab, exact: true }).click();
  await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
}

export const SURFACES: Surface[] = [
  // ── Sidebar / tree ────────────────────────────────────────────────────────────────────────
  { id: "tree", path: "/e2e-fixtures/pages-nav.html", open: async (page, vp) => {
    const scope = vp === "phone" ? await drawer(page) : nav(page);
    const tree = scope.getByRole("region", { name: "Pages", exact: true });
    await expect(tree.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
    const toggle = tree.getByRole("button", { name: "Expand Plan", exact: true });
    if (await toggle.count()) await toggle.click();
    await expect(tree.getByRole("button", { name: "Week 1", exact: true })).toBeVisible();
    if (vp === "desktop") await tree.getByRole("button", { name: "Plan", exact: true }).hover();
  } },
  { id: "tree-row-menu", path: "/e2e-fixtures/pages-nav.html", open: async (page, vp) => {
    if (vp === "phone") {
      const d = await drawer(page);
      await d.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Plan" }).getByRole("button", { name: "Move to Trash" })).toBeVisible();
    } else {
      await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
      await expect(page.getByRole("menu").getByRole("menuitem", { name: "Move to Trash", exact: true })).toBeVisible();
    }
  } },
  { id: "sidebar-peek", only: "desktop", path: "/e2e-fixtures/notion-shell.html?collapsed", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "Show sidebar preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Sidebar preview" })).toBeVisible();
  } },
  { id: "new-page-chooser", path: "/e2e-fixtures/page-creation.html", open: async (page) => {
    await page.getByRole("button", { name: "New page" }).first().click();
    await expect(page.getByRole("dialog", { name: "New page", exact: true })).toBeVisible();
  } },
  // ── Page + editors ────────────────────────────────────────────────────────────────────────
  { id: "shell-page", path: "/e2e-fixtures/notion-shell.html", open: editorReady },
  { id: "shell-page-inbox-badge", path: "/e2e-fixtures/notion-shell.html?inbox&favorites", open: editorReady },
  { id: "editor-blocks", path: "/e2e-fixtures/editor-blocks.html", open: editorReady },
  { id: "editor-media", path: "/e2e-fixtures/notion-media.html", before: async (page) => { await serveAttachments(page); }, open: editorReady },
  { id: "editor-live", path: "/e2e-fixtures/notion-mentions.html?comments", open: async (page) => {
    await expect(page.locator(".ProseMirror").first()).toContainText("The rollout plan is ready");
  } },
  { id: "editor-live-pair", path: "/e2e-fixtures/notion-media.html?live", before: async (page) => { await serveAttachments(page); }, open: async (page) => {
    await expect(page.locator(".ProseMirror").first()).toBeVisible();
  } },
  { id: "slash-menu", path: "/e2e-fixtures/editor-blocks.html", open: async (page) => {
    await editorReady(page);
    await page.locator(".tiptap[contenteditable=true]").click();
    await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox", { name: "Insert block" })).toBeVisible();
  } },
  { id: "block-menu", path: "/e2e-fixtures/editor-blocks.html", open: blockMenu },
  { id: "block-menu-turn-into", only: "desktop", path: "/e2e-fixtures/editor-blocks.html", open: async (page, vp) => {
    await blockMenu(page, vp);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menu", { name: "Turn into" }).getByRole("menuitemradio", { name: "Text" })).toBeVisible();
  } },
  { id: "block-menu-color", only: "desktop", path: "/e2e-fixtures/editor-blocks.html", open: async (page, vp) => {
    await blockMenu(page, vp);
    await page.getByRole("menuitem", { name: "Color" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Blue background" })).toBeVisible();
  } },
  { id: "selection-toolbar", path: "/e2e-fixtures/editor-blocks.html", open: async (page) => { await selectBravo(page); } },
  { id: "selection-toolbar-color", path: "/e2e-fixtures/editor-blocks.html", open: async (page) => {
    const bubble = await selectBravo(page);
    await bubble.getByRole("button", { name: "Text color and highlight" }).click();
    await expect(page.getByRole("menu", { name: "Color" }).getByRole("menuitemradio", { name: "Default" })).toBeVisible();
  } },
  { id: "selection-toolbar-turn-into", path: "/e2e-fixtures/editor-blocks.html", open: async (page) => {
    const bubble = await selectBravo(page);
    await bubble.getByRole("button", { name: /^Turn into/ }).click();
    await expect(page.getByRole("menuitemradio", { name: "Heading 2" })).toBeVisible();
  } },
  { id: "mention-menu", path: "/e2e-fixtures/notion-mentions.html", open: async (page) => {
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Owner: @");
    await expect(page.getByRole("listbox", { name: "Mention a person, page or date" })).toBeVisible();
  } },
  { id: "find-bar", path: "/e2e-fixtures/editor-blocks.html", open: async (page) => {
    await editorReady(page);
    await page.locator(".tiptap[contenteditable=true]").click();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("search").or(page.locator(".editor-find-bar, .prism-find-bar")).first()).toBeVisible();
  } },
  { id: "page-actions-menu", path: "/e2e-fixtures/pages-nav.html?open=prism", open: async (page, vp) => {
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    if (vp === "phone") await expect(page.getByRole("button", { name: "Close sheet" })).toBeVisible();
    else await expect(page.getByRole("menuitem", { name: "Open in new tab", exact: true })).toBeVisible();
  } },
  { id: "page-cover-dialog", only: "desktop", path: "/e2e-fixtures/notion-media.html", before: async (page) => { await serveAttachments(page); }, open: async (page) => {
    await editorReady(page);
    await page.locator(".document-page-header").hover();
    await page.getByRole("button", { name: "Add cover" }).click();
    await page.locator(".document-cover").hover();
    await page.getByRole("button", { name: "Change cover" }).click();
    await expect(page.getByRole("dialog", { name: "Page cover" })).toBeVisible();
  } },
  { id: "icon-picker", path: "/e2e-fixtures/notion-shell.html", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "Add icon" }).click();
    await expect(page.locator(".EmojiPickerReact")).toBeVisible();
  } },
  // ── ⌘K + search ───────────────────────────────────────────────────────────────────────────
  { id: "command-bar", path: "/e2e-fixtures/notion-shell.html", open: async (page) => {
    await editorReady(page);
    await page.evaluate(() => (window as any).prismShellUI.getState().openCommandBar());
    const input = page.getByRole("combobox", { name: "Search notes and commands" });
    await expect(input).toBeVisible();
    await input.fill("workshop");
    await expect(page.getByRole("group", { name: "Notes" }).getByRole("option").first()).toBeVisible();
  } },
  { id: "command-bar-filters", path: "/e2e-fixtures/notion-shell.html", open: async (page) => {
    await editorReady(page);
    await page.evaluate(() => (window as any).prismShellUI.getState().openCommandBar());
    await page.getByRole("combobox", { name: "Search notes and commands" }).fill("workshop");
    await page.getByRole("button", { name: "Filters" }).click();
    await expect(page.getByRole("group", { name: "Search filters" }).getByRole("combobox", { name: "Type" })).toBeVisible();
  } },
  { id: "search-page", path: "/e2e-fixtures/search.html", open: async (page) => {
    await expect(page.getByRole("region", { name: "Search results" })).toContainText("Ranked search");
  } },
  // ── Databases ─────────────────────────────────────────────────────────────────────────────
  { id: "db-table", path: "/e2e-fixtures/databases.html", open: dbReady },
  { id: "db-board", path: "/e2e-fixtures/databases.html", open: (page) => dbView(page, "Board") },
  { id: "db-gallery", path: "/e2e-fixtures/databases.html", open: (page) => dbView(page, "Gallery") },
  { id: "db-list", path: "/e2e-fixtures/databases.html", open: (page) => dbView(page, "List") },
  { id: "db-calendar", path: "/e2e-fixtures/databases.html", open: (page) => dbView(page, "Calendar") },
  // Phones get the calendar as a week list (above, at 390 px); the dense month grid is opt-in ("Month").
  { id: "db-calendar-month", path: "/e2e-fixtures/databases.html", only: "phone", open: async (page) => {
    await dbView(page, "Calendar");
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(page.getByRole("grid", { name: "Calendar calendar" })).toBeVisible();
  } },
  { id: "db-filter", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const filter = page.getByRole("dialog", { name: "Filter" });
    await filter.getByRole("button", { name: "Add filter" }).click();
    await expect(filter).toBeVisible();
  } },
  { id: "db-sort", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    const sort = page.getByRole("dialog", { name: "Sort" });
    await sort.getByRole("button", { name: /Add sort/ }).click();
    await expect(sort).toBeVisible();
  } },
  { id: "db-view-settings", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "View settings" }).click();
    await expect(page.getByRole("dialog", { name: "View settings" }).getByRole("list", { name: "Visible properties" })).toBeVisible();
  } },
  { id: "db-add-view", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Add a view" }).click();
    await expect(page.getByRole("button", { name: "Add a view" })).toHaveAttribute("aria-expanded", "true");
  } },
  { id: "db-column-menu", only: "desktop", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Due", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Sort descending" })).toBeVisible();
  } },
  { id: "db-select-editor", only: "desktop", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await dbRow(page, "Refine onboarding copy").getByRole("button", { name: "Status: in-progress" }).click();
    await expect(page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "done" })).toBeVisible();
  } },
  { id: "db-date-editor", only: "desktop", path: "/e2e-fixtures/databases.html?free-dates", open: async (page) => {
    await dbReady(page);
    await dbRow(page, "Refine onboarding copy").getByRole("button", { name: /^Due:/ }).click();
    await page.getByRole("button", { name: "Time and end date for Due" }).click();
    await expect(page.getByRole("dialog", { name: "Edit Due" })).toBeVisible();
  } },
  { id: "db-row-peek-side", only: "desktop", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Refine onboarding copy", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Refine onboarding copy (side peek)" })).toBeVisible();
  } },
  { id: "db-row-peek-center", only: "desktop", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "Refine onboarding copy", exact: true }).click();
    await page.getByRole("dialog", { name: /side peek/ }).getByRole("button", { name: "Center peek" }).click();
    await expect(page.getByRole("dialog", { name: "Refine onboarding copy (center peek)" })).toBeVisible();
  } },
  { id: "db-bulk-bar", only: "desktop", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("table", { name: "All tasks" }).getByRole("checkbox", { name: "Select Refine onboarding copy" }).click();
    await expect(page.getByRole("toolbar", { name: "Selected pages" })).toBeVisible();
  } },
  { id: "db-csv-import", path: "/e2e-fixtures/databases.html", open: async (page) => {
    await dbReady(page);
    await page.getByRole("button", { name: "More database actions" }).click();
    await page.getByRole("menuitem", { name: "Import CSV…" }).click();
    await expect(page.getByRole("dialog", { name: "Import CSV" })).toBeVisible();
  } },
  { id: "db-page-properties", path: "/e2e-fixtures/context-properties.html", open: async (page) => {
    await expect(page.getByRole("group", { name: "Page properties" }).first()).toBeVisible();
  } },
  { id: "task-board", path: "/e2e-fixtures/boards.html", open: async (page) => { await expect(page.locator("main, #root > *").first()).toBeVisible(); await page.waitForLoadState("networkidle"); } },
  // ── Sharing ───────────────────────────────────────────────────────────────────────────────
  { id: "share-people", path: "/e2e-fixtures/sharing.html?page", open: (page) => shareDialog(page) },
  { id: "share-link", path: "/e2e-fixtures/sharing.html?page", open: (page) => shareDialog(page, "Link access") },
  { id: "share-publish", path: "/e2e-fixtures/sharing.html?page", open: (page) => shareDialog(page, "Publish") },
  { id: "share-sync", path: "/e2e-fixtures/sharing.html?page", open: (page) => shareDialog(page, "Sync") },
  // ── Comments ──────────────────────────────────────────────────────────────────────────────
  { id: "comments", path: "/e2e-fixtures/notion-comments.html", open: async (page) => {
    const mine = page.getByRole("main", { name: "Your view" }).getByRole("region", { name: "Page discussion" });
    await mine.getByRole("button", { name: "Add comment" }).click();
    await mine.getByRole("textbox", { name: "Comment on this page" }).fill("Should this page move to the handbook?");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(mine.locator("[data-comment-id]")).toHaveCount(1);
    await page.evaluate(() => (window as any).prismDiscussion.seedAnchored());
    await expect(page.getByRole("complementary", { name: "Comments sidebar" })).toContainText("the spring launch");
  } },
  { id: "comments-live-panel", path: "/e2e-fixtures/notion-mentions.html?comments", open: async (page) => {
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("The rollout plan is ready");
    await editor.click();
    await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout plan"));
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.getByRole("textbox", { name: "Comment" }).pressSequentially("Can you review this?");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByRole("complementary", { name: "Comments panel" })).toContainText("review this?");
  } },
  { id: "suggestion-review", path: "/e2e-fixtures/suggestion-review.html", open: async (page) => { await expect(page.locator(".ProseMirror").first()).toBeVisible(); } },
  // ── Inbox + Home ──────────────────────────────────────────────────────────────────────────
  { id: "inbox", path: "/e2e-fixtures/notion-inbox.html?reset&open=notifications", before: pinClock, open: async (page) => {
    const inbox = page.getByTestId("notifications-inbox");
    await expect(inbox.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
    await expect(inbox.getByTestId("notification-row").first()).toBeVisible();
  } },
  { id: "inbox-settings", path: "/e2e-fixtures/notion-inbox.html?reset&open=notifications&no-push", before: pinClock, open: async (page) => {
    const inbox = page.getByTestId("notifications-inbox");
    await expect(inbox.getByTestId("notification-row").first()).toBeVisible();
    await inbox.getByRole("button", { name: "Notification settings" }).click();
    await expect(page.getByTestId("notification-settings")).toBeVisible();
  } },
  { id: "home", path: "/e2e-fixtures/notion-inbox.html?reset", before: async (page) => {
    await pinClock(page);
    await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { startWithLastDocument: false }, version: 0 })));
  }, open: async (page) => { await expect(page.getByTestId("home").getByRole("region", { name: "Recently visited" })).toBeVisible(); } },
  // ── Settings ──────────────────────────────────────────────────────────────────────────────
  { id: "settings-appearance", path: "/e2e-fixtures/workspace.html", open: (page) => settings(page, "Appearance") },
  { id: "settings-inputs", path: "/e2e-fixtures/workspace.html?connections", open: (page) => settings(page, "Inputs & integrations") },
  { id: "settings-ai", path: "/e2e-fixtures/workspace.html", open: (page) => settings(page, "AI & agent") },
  { id: "settings-advanced", path: "/e2e-fixtures/workspace.html", open: (page) => settings(page, "Advanced") },
  { id: "page-properties-customize", path: "/e2e-fixtures/databases.html?open=page", open: async (page) => {
    await page.getByRole("group", { name: "Page properties" }).getByRole("button", { name: "Customize…" }).click();
    await page.getByRole("dialog", { name: "Customize properties" }).getByLabel("Show Due at top").check();
    await expect(page.getByRole("dialog", { name: "Customize properties" }).getByRole("button", { name: "Move Due up" })).toBeVisible();
  } },
  { id: "settings-account", only: "desktop", path: "/e2e-fixtures/notion-shell.html?account", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("tab", { name: /Account/ }).or(page.getByRole("button", { name: "Account", exact: true })).first().click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  } },
  { id: "account-menu", only: "desktop", path: "/e2e-fixtures/notion-shell.html?account", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  } },
  // ── Import / export ───────────────────────────────────────────────────────────────────────
  { id: "import-dialog", path: "/e2e-fixtures/notion-transfer.html", before: async (page) => { await serveAttachments(page); }, open: async (page) => {
    await page.waitForFunction(() => !!(window as any).prismTransfer);
    await page.evaluate(() => (window as any).prismTransfer.ui.getState().openImport({}));
    await expect(page.getByRole("dialog", { name: "Import", exact: true })).toBeVisible();
  } },
  { id: "export-dialog", only: "desktop", path: "/e2e-fixtures/notion-transfer.html", before: async (page) => { await serveAttachments(page); }, open: async (page) => {
    await command(page, "Export Workspace…");
    await expect(page.getByRole("dialog", { name: "Export workspace" })).toBeVisible();
  } },
  { id: "export-page-dialog", only: "desktop", path: "/e2e-fixtures/notion-transfer.html?open=prism", before: async (page) => { await serveAttachments(page); }, open: async (page) => {
    await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Export…/ }).click();
    await expect(page.getByRole("dialog", { name: "Export “Prism”" })).toBeVisible();
  } },
  // ── Trash, move, toast ────────────────────────────────────────────────────────────────────
  { id: "move-dialog", only: "desktop", path: "/e2e-fixtures/pages-nav.html", open: async (page) => {
    await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const move = page.getByRole("dialog", { name: "Move “Plan”" });
    await move.getByLabel("Find a page or folder").fill("Archive");
    await expect(move.getByRole("option", { name: /Archive/ })).toBeVisible();
  } },
  { id: "trash-and-toast", only: "desktop", path: "/e2e-fixtures/pages-nav.html", open: async (page) => {
    await nav(page).getByRole("button", { name: "Page actions for Plan", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move to Trash" }).click();
    await expect(page.getByRole("status").filter({ hasText: "to Trash" }).getByRole("button", { name: "Undo" })).toBeVisible();
    await nav(page).getByRole("button", { name: "Trash", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Trash" })).toBeVisible();
  } },
  // ── History ───────────────────────────────────────────────────────────────────────────────
  { id: "history-panel", path: "/e2e-fixtures/context-history.html", open: async (page) => {
    await expect(page.locator(".prism-context-history button.prism-context-history-row")).toHaveCount(3);
  } },
  { id: "history-viewer", path: "/e2e-fixtures/context-history.html", open: async (page) => {
    await page.locator(".prism-context-history button.prism-context-history-row").first().click();
    await expect(page.getByRole("dialog", { name: "Version history" })).toBeVisible();
  } },
  { id: "history-updates", path: "/e2e-fixtures/notion-sharing.html?panel=history", open: async (page) => {
    await expect(page.locator(".prism-context-history .prism-context-history-row").first()).toBeVisible();
    await page.getByRole("tab", { name: "Updates" }).click();
    await expect(page.getByLabel("Page updates").locator("li").first()).toBeVisible();
  } },
  // ── Shortcut sheet ────────────────────────────────────────────────────────────────────────
  { id: "shortcut-sheet", path: "/e2e-fixtures/notion-shell.html", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "Page actions", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+/");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  } },
  // ── Agent ─────────────────────────────────────────────────────────────────────────────────
  { id: "agent-chat", path: "/e2e-fixtures/agent.html?history&permissions", open: async (page) => {
    await expect(page.getByTestId("agent-assistant-message").first()).toContainText("A shared place to think");
    await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  } },
  { id: "agent-chat-empty", path: "/e2e-fixtures/agent.html?permissions", open: async (page) => {
    await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  } },
  { id: "agent-companion", only: "desktop", path: "/e2e-fixtures/notion-shell.html", open: async (page) => {
    await editorReady(page);
    await page.getByRole("button", { name: "AI Agent", exact: true }).click();
    await expect(page.getByLabel("Document companion")).toBeVisible();
  } },
  { id: "agent-companion-phone", only: "phone", path: "/e2e-fixtures/workspace.html?navigation&agent", open: async (page) => {
    await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Document panel" })).toBeVisible();
  } },
  { id: "phone-more-sheet", only: "phone", path: "/e2e-fixtures/workspace.html?agent", open: async (page) => {
    await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator("dialog.prism-mobile-sheet")).toBeVisible();
  } },
  // ── Pass 2: surfaces the first sweep skipped ─────────────────────────────────────────────
  { id: "sign-in", path: "/e2e-fixtures/auth-screens.html", open: async (page) => {
    await expect(page.getByRole("button", { name: /Sign in|Log in/ }).first()).toBeVisible();
  } },
  { id: "accept-invite", path: "/e2e-fixtures/auth-screens.html?screen=register", before: async (page) => {
    await page.route("**/auth/invite-info**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, email: "guest@example.test" }) }));
  }, open: async (page) => {
    await expect(page.getByText("guest@example.test").first()).toBeVisible();
  } },
  { id: "published-wiki", path: "/e2e-fixtures/publication.html", open: async (page) => {
    await expect(page.getByText("PRISM_PUBLICATION_guide_first_BODY", { exact: true })).toBeVisible();
  } },
  { id: "published-wiki-locked", path: "/e2e-fixtures/publication.html?protected&empty", open: async (page) => {
    await expect(page.locator("input[type=password]").first()).toBeVisible();
  } },
  { id: "people-directory", path: "/e2e-fixtures/workspace.html?people", open: async (page) => {
    await expect(page.getByRole("region", { name: "People workspace" }).getByRole("heading", { name: "People", exact: true })).toBeVisible();
  } },
  { id: "people-profile", path: "/e2e-fixtures/people-profile.html", open: async (page) => {
    await expect(page.locator("main, #root > *").first()).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
  } },
  { id: "messages-inbox", path: "/e2e-fixtures/inbox.html", open: async (page) => {
    await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  } },
  { id: "messages-people", path: "/e2e-fixtures/inbox.html?resolved", open: async (page) => {
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.getByRole("button", { name: /Mira Chen/ }).click();
    await expect(page.getByRole("region", { name: "Conversations with Mira Chen" })).toBeVisible();
  } },
  { id: "message-thread", path: "/e2e-fixtures/messages.html", open: async (page) => {
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  } },
  { id: "email-thread", path: "/e2e-fixtures/messages.html?email-visual&agent", open: async (page) => {
    await expect(page.getByText("Show quoted history", { exact: true })).toBeVisible();
  } },
  { id: "calendar-dashboard", path: "/e2e-fixtures/calendar.html", open: async (page) => {
    // The phone opens on the day view; the desktop on the month with its events.
    await expect(page.getByRole("button", { name: "Create event" })).toBeVisible();
  } },
  { id: "governance", path: "/e2e-fixtures/governance-workspace.html", open: async (page) => {
    await expect(page.getByTestId("gov-your-access")).toBeVisible();
  } },
  { id: "governance-proposals", path: "/e2e-fixtures/governance-workspace.html", open: async (page) => {
    await expect(page.getByTestId("gov-your-access")).toBeVisible();
    await page.getByRole("tab", { name: /Proposals/ }).click();
    await expect(page.getByTestId("gov-proposal-card").first()).toBeVisible();
  } },
  { id: "map-fallback", path: "/e2e-fixtures/renderer-preservation.html?kind=map", before: async (page) => {
    // No WebGL (as on a headless runner or a locked-down device): the map shows its list fallback.
    await page.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: any, ...args: any[]) { if (String(type).includes("webgl")) return null; return (get as any).call(this, type, ...args); } as any; });
  }, open: async (page) => {
    await expect(page.getByTestId("vault-map")).toHaveAttribute("data-map-fallback", "true");
  } },
];

/** Force the theme the same way Settings → Appearance does (class on <html>), after the fixture booted. */
export async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((t) => { const c = document.documentElement.classList; c.remove("light", "dark"); c.add(t); }, theme);
}

export async function openSurface(page: Page, s: Surface, vp: Viewport, theme: Theme) {
  await page.setViewportSize(VIEWPORTS[vp]);
  await s.before?.(page);
  await page.goto(s.path);
  await setTheme(page, theme);
  await s.open(page, vp);
  // The fixture may re-apply its own theme while booting; ours is the last word.
  await setTheme(page, theme);
  // Let enter transitions finish (≤180 ms by NP-AX-06) so colours are measured at rest — and any colour
  // transition the theme flip itself started (a half-way colour is neither theme's).
  await page.waitForTimeout(250);
  // Inherited colours re-transition level by level (each child chases its parent's moving value), so
  // wait until no transition is running at all, not just for the ones running now.
  await page.waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition), null, { timeout: 8000 }).catch(() => {});
}
