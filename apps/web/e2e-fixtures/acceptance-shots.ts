/**
 * Acceptance screenshots for the Notion-parity review (checklist §4 step 4).
 *
 * The LIST of shots: which checklist row, which fixture, how to reach the state. It is data plus
 * small driving functions — no `@playwright/test` runtime import, so the gallery generator
 * (`scripts/build-acceptance-gallery.mjs`) can load it for the titles and notes.
 *
 * Each shot is captured light + dark, at 1440×900 ("desktop") and/or 390×844 ("phone").
 * Run by `acceptance-shots.spec.ts` (only with PRISM_SHOTS=1). How to regenerate:
 * docs/roadmap/workspace-experience/ACCEPTANCE-SHOTS.md.
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";

export type Viewport = "desktop" | "phone";
export type Theme = "light" | "dark";
export interface ShotCtx { phone: boolean; theme: Theme; context: BrowserContext }
export interface Shot {
  /** Checklist row id (NP-…), or X-… for a surface no row names. */
  id: string;
  /** Checklist section, as its heading reads. */
  section: string;
  /** File-name part; unique per id. */
  slug: string;
  /** Caption for the gallery. */
  title: string;
  /** What the reviewer should look at in this state. */
  look: string;
  url: string | ((c: ShotCtx) => string);
  viewports: Viewport[];
  /** Drive the fixture to the state. Runs once per theme, on a fresh page. */
  setup?: (page: Page, c: ShotCtx) => Promise<void>;
  /** Phone shots emulate a touch device unless this is false (the steps need a mouse). */
  touch?: boolean;
  /** Extra `prism-settings` state (the theme is always set). */
  settings?: Record<string, unknown>;
  /** Needs the real-server fixture (apps/server e2e-server over the fake vault). */
  realServer?: boolean;
}

export const SECTIONS = [
  "2.1 Sidebar and workspace navigation",
  "2.2 Page chrome",
  "2.3 Editor and blocks",
  "2.4 Inline references",
  "2.5 Databases",
  "2.6 Collaboration, sharing and notifications",
  "2.7 Search and ⌘K",
  "2.8 Templates, import and export",
  "2.9 Prism agent",
  "2.10 Phone app patterns",
  "2.11 Offline, sync and reliability",
  "Other surfaces",
] as const;
const [SB, PG, ED, RF, DB, CO, SR, TX, AI, MB, OF, OTHER] = SECTIONS;

/* ───────────── helpers ───────────── */

const vis = (l: Locator, timeout = 20_000) => l.first().waitFor({ state: "visible", timeout });
const fx = (name: string, q = "") => `/e2e-fixtures/${name}.html${q}`;
const enc = encodeURIComponent;
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]").first();
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const tree = (page: Page) => nav(page).getByRole("region", { name: "Pages", exact: true });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Workspace navigation" });
const mod = "ControlOrMeta";

/** Phone: open the Browse drawer; returns the navigation container for either layout. */
async function navigation(page: Page, c: ShotCtx): Promise<Locator> {
  if (!c.phone) { await vis(nav(page)); return nav(page); }
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await vis(drawer(page));
  return drawer(page);
}

async function typeAtEnd(page: Page, text: string) {
  await vis(editor(page));
  await editor(page).click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type(text);
}

/** Caret at the end of the document on a fresh empty line. */
async function newLine(page: Page) {
  await vis(editor(page));
  await editor(page).click();
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
  await page.keyboard.press("Enter");
}

async function clickInto(page: Page, text: string) {
  await page.getByText(text, { exact: true }).first().click();
  await page.waitForFunction((t) => (document.querySelector(".tiptap") as any)?.editor?.state.selection.$from.parent.textContent === t, text);
}

async function selectText(page: Page, text: string) {
  await page.getByText(text, { exact: true }).first().click();
  await page.getByText(text, { exact: true }).first().selectText();
  await page.waitForFunction((t) => { const e = (document.querySelector(".tiptap") as any)?.editor; if (!e) return false; const { from, to } = e.state.selection; return e.state.doc.textBetween(from, to) === t; }, text);
  await vis(page.locator(".document-selection-actions:visible, .cd-bubble:visible"));
}

async function palette(page: Page, c: ShotCtx): Promise<Locator> {
  if (c.phone) await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Search", exact: true }).click();
  else await page.keyboard.press(`${mod}+k`);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await vis(dialog);
  return dialog;
}

async function runCommand(page: Page, c: ShotCtx, name: string) {
  const dialog = await palette(page, c);
  await dialog.getByRole("combobox").fill(name);
  const option = dialog.getByRole("option", { name }).first();
  await vis(option);
  await page.waitForTimeout(400); // rows settle while page results arrive
  await option.click();
}

async function openShare(page: Page) {
  await page.getByRole("button", { name: "Share fixture", exact: true }).click();
  await vis(page.getByRole("dialog", { name: "Share document" }));
}

/** A small valid ZIP of a Notion export is built in the spec (needs the repo's zip writer). */
export const IMPORT_FILE = { name: "Field notes.md", mimeType: "text/markdown", text: "# Field notes\n\nStart with the plan, then the reading list.\n\n- River survey\n- Bird count\n" };

const ALL_TEXT_BLOCKS =
  "<h1>Heading 1</h1>" +
  '<p>Paragraph with <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <s>strikethrough</s>, <code>inline code</code>, <a href="https://example.test/docs">a link</a>, <span data-text-color="red">red text</span>, <span data-text-color="blue">blue text</span> and <mark>a highlight</mark>.</p>' +
  "<h2>Heading 2</h2><h3>Heading 3</h3>" +
  "<ul><li><p>Bulleted item</p><ul><li><p>Nested bullet</p></li></ul></li><li><p>Second bullet</p></li></ul>" +
  "<ol><li><p>Numbered item</p></li><li><p>Second number</p></li></ol>" +
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Finished to-do</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Open to-do</p></div></li></ul>' +
  '<details data-type="toggle"><summary>Toggle (closed)</summary><p>Hidden body</p></details>' +
  '<details data-type="toggle" data-heading-level="2"><summary>Toggle heading 2</summary><p>Body under a toggle heading</p></details>' +
  "<blockquote><p>A quote that runs a little longer so the rule on its left has something to stand beside.</p></blockquote>" +
  '<div data-type="callout" data-emoji="💡"><p>Callout: mind the gap between the platform and the train.</p></div>' +
  '<p data-block-color="blue_background">A paragraph with a blue background.</p>' +
  '<p data-block-color="red">A paragraph in red text.</p>' +
  "<hr><p>After the divider.</p>";

const RICH_BLOCKS =
  "<h2>Rich blocks</h2>" +
  '<pre><code class="language-typescript">export function greet(name: string): string {\n  return `Hello, ${name}!`; // a comment\n}</code></pre>' +
  "<table><tbody><tr><th><p>River</p></th><th><p>Length</p></th><th><p>Mouth</p></th></tr><tr><td><p>Platte</p></td><td><p>499 km</p></td><td><p>Missouri</p></td></tr><tr><td><p>Yampa</p></td><td><p>402 km</p></td><td><p>Green</p></td></tr></tbody></table>" +
  '<div data-type="columns"><div data-type="column"><p><strong>Left column</strong></p><p>Notes from the east bank.</p></div><div data-type="column"><p><strong>Right column</strong></p><p>Notes from the west bank.</p></div></div>' +
  '<img src="/e2e-fixtures/fixture-image.svg" alt="chart" data-caption="Figure 1 — a captioned image">' +
  '<div data-type="toc"></div>' +
  '<div data-type="bookmark" data-url="https://example.test/field-guide" data-title="Field guide to the Front Range" data-description="A long description of the linked page that should wrap or truncate cleanly inside the bookmark card." data-site="example.test"><a href="https://example.test/field-guide">Field guide</a></div>' +
  '<div data-type="attachment" data-kind="file" data-src="https://example.test/files/survey-2026.zip" data-name="survey-2026.zip" data-size="2048576" data-mime="application/zip"><a href="https://example.test/files/survey-2026.zip">survey-2026.zip</a></div>' +
  '<div data-type="embed" data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Video</a></div>' +
  "<p>Closing paragraph.</p>";

const LINKS =
  '<p>Read <a href="https://example.test/docs">the docs</a> first.</p>' +
  '<p>Then <a href="/page/db1">the reading list</a> here.</p>' +
  '<p>A chip <span data-type="mention" data-kind="page" data-id="db1" data-mention-uid="u1">@page</span> and a wikilink [[Books/Braiding Sweetgrass]].</p>' +
  "<p>Closing line.</p>";

/* ───────────── the shots ───────────── */

export const SHOTS: Shot[] = [
  /* 2.1 Sidebar */
  {
    id: "NP-SB-01", section: SB, slug: "vault-switcher", title: "Vault switcher open", viewports: ["desktop", "phone"],
    look: "Switcher at the top of the sidebar / drawer, current vault named, every vault listed plus Manage. Menu aligned under its trigger, not clipped.",
    url: fx("workspace", "?navigation"),
    setup: async (page, c) => { const n = await navigation(page, c); await n.getByRole("button", { name: "Switch vault" }).click(); await vis(n.getByRole("menu")); },
  },
  {
    id: "NP-SB-02", section: SB, slug: "sidebar-search-row", title: "Workspace at rest: sidebar, tabs, header, page", viewports: ["desktop", "phone"],
    look: "Search is a sidebar row. Overall first impression: sidebar density, header row (save state, star, Share, ⋯, Agent), page typography. Favorites empty text.",
    url: fx("notion-shell", "?inbox&account"),
    setup: async (page) => { await vis(editor(page)); },
  },
  {
    id: "NP-SB-03", section: SB, slug: "home", title: "Home", viewports: ["desktop", "phone"],
    look: "Greeting, Recently visited, Upcoming, My tasks, unread mentions. Compare with Notion Home: card rhythm, section headings, empty space.",
    url: fx("notion-inbox", "?reset"), settings: { startWithLastDocument: false },
    setup: async (page) => { await vis(page.getByTestId("home")); await vis(page.getByTestId("home").getByRole("region", { name: "My tasks" })); },
  },
  {
    id: "NP-SB-04", section: SB, slug: "favorites-recents", title: "Favorites and Recent filled", viewports: ["desktop", "phone"],
    look: "Favorites always visible with starred pages (icons), Recent list. Row alignment with the tree below.",
    url: fx("pages-nav", `?prefs=${enc(JSON.stringify({ favorites: ["plan", "week1"], recents: ["week1", "archive", "plan"] }))}`),
    setup: async (page, c) => {
      const n = await navigation(page, c);
      await vis(n.getByRole("region", { name: "Favorites", exact: true }).getByRole("button", { name: "Plan", exact: true }));
      const toggle = n.getByRole("region", { name: "Recent", exact: true }).getByRole("button", { name: "Recent", exact: true });
      if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    },
  },
  {
    id: "NP-SB-06", section: SB, slug: "page-tree", title: "Page tree with nested pages; row hover shows + and ⋯", viewports: ["desktop", "phone"],
    look: "Pages (not only folders) with icons, disclosure chevrons, indentation. Desktop: hovered row shows + and ⋯ without shifting the label.",
    url: fx("pages-nav"),
    setup: async (page, c) => {
      const n = await navigation(page, c);
      const pages = n.getByRole("region", { name: "Pages", exact: true });
      await vis(pages.getByRole("button", { name: "Plan", exact: true }));
      const expand = pages.getByRole("button", { name: "Expand Plan", exact: true });
      if (await expand.count()) await expand.click();
      await vis(pages.getByRole("button", { name: "Week 1", exact: true }));
      if (!c.phone) await pages.getByRole("button", { name: "Plan", exact: true }).hover();
    },
  },
  {
    id: "NP-SB-07", section: SB, slug: "tree-row-menu", title: "Tree row ⋯ menu", viewports: ["desktop", "phone"],
    look: "Menu items (Favorite, Copy link, Duplicate, Rename, Move to, Open in new tab, Trash); phone shows the same actions as a sheet.",
    url: fx("pages-nav"),
    setup: async (page, c) => {
      const n = await navigation(page, c);
      await vis(n.getByRole("region", { name: "Pages", exact: true }).getByRole("button", { name: "Plan", exact: true }));
      if (!c.phone) await n.getByRole("region", { name: "Pages", exact: true }).getByRole("button", { name: "Plan", exact: true }).hover();
      await n.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "NP-SB-09", section: SB, slug: "shared-with-me", title: "Shared with me (member)", viewports: ["desktop"],
    look: "A Shared with me section listing pages others shared, with who shared them.",
    url: fx("pages-nav", "?shared"),
    setup: async (page) => { await vis(page.getByRole("region", { name: "Shared with me" })); },
  },
  {
    id: "NP-SB-10", section: SB, slug: "trash", title: "Trash", viewports: ["desktop", "phone"],
    look: "Trash dialog: search, a trashed page with its sub-page count, Restore / Delete, the retention notice.",
    url: fx("pages-nav"),
    setup: async (page, c) => {
      const n = await navigation(page, c);
      await vis(n.getByRole("region", { name: "Pages", exact: true }).getByRole("button", { name: "Plan", exact: true }));
      await n.getByRole("button", { name: "Page actions for Plan", exact: true }).click();
      await page.getByRole(c.phone ? "button" : "menuitem", { name: "Move to Trash" }).first().click();
      await page.getByRole("status").filter({ hasText: "to Trash" }).first().waitFor();
      const n2 = c.phone && !(await drawer(page).isVisible()) ? await navigation(page, c) : n;
      await n2.getByRole("button", { name: "Trash", exact: true }).click();
      await vis(page.getByRole("dialog", { name: "Trash" }).getByRole("listitem", { name: "Plan" }));
    },
  },
  {
    id: "NP-SB-12", section: SB, slug: "sidebar-peek", title: "Collapsed sidebar peeks on left-edge hover", viewports: ["desktop"],
    look: "The peek floats over the page (the document keeps its width), with a shadow and rounded edge; nothing underneath shifts.",
    url: fx("notion-shell", "?collapsed"),
    setup: async (page) => {
      await vis(editor(page));
      await page.mouse.move(400, 400);
      await page.mouse.move(3, 400, { steps: 4 });
      await vis(page.getByRole("complementary", { name: "Sidebar preview" }));
    },
  },
  {
    id: "NP-SB-14", section: SB, slug: "tools-section", title: "Tools section expanded", viewports: ["desktop", "phone"],
    look: "Tools is collapsed by default; expanded it lists Calendar, People, Automations, Map … as quiet rows below the pages.",
    url: fx("workspace", "?navigation"),
    setup: async (page, c) => { const n = await navigation(page, c); await n.getByRole("button", { name: "Tools", exact: true }).click(); await vis(n.getByRole("button", { name: "Map", exact: true })); },
  },
  {
    id: "NP-SB-15", section: SB, slug: "footer-offline", title: "Sidebar footer: Offline · saved on this device", viewports: ["desktop"],
    look: "Footer sync state reads Offline · saved on this device (never Synced) with Settings beside it; header badge agrees.",
    url: fx("notion-shell", "?account"),
    setup: async (page, c) => {
      await vis(editor(page));
      await c.context.setOffline(true);
      await typeAtEnd(page, " Footer offline edit.");
      await page.locator(".workspace-navigation .sync-state-footer", { hasText: "Offline" }).waitFor({ timeout: 12_000 });
    },
  },

  /* 2.2 Page chrome */
  {
    id: "NP-PG-01", section: PG, slug: "icon-picker", title: "Icon picker open", viewports: ["desktop", "phone"],
    look: "Searchable emoji picker anchored to the icon control; in dark the picker must be dark too.",
    url: fx("notion-shell"),
    setup: async (page) => { await vis(editor(page)); await page.getByRole("button", { name: "Add icon" }).click(); await vis(page.locator(".EmojiPickerReact")); await page.waitForTimeout(500); },
  },
  {
    id: "NP-PG-01", section: PG, slug: "icon-everywhere", title: "Icon shown on the page, tab and tree", viewports: ["desktop"],
    look: "After choosing an icon it appears beside the title, in the tab and in the sidebar row at once.",
    url: fx("notion-shell"),
    setup: async (page) => {
      await vis(editor(page));
      await page.getByRole("button", { name: "Add icon" }).click();
      await page.locator(".EmojiPickerReact button.epr-emoji:visible").first().click();
      await vis(page.locator(".document-icon-control.has-icon"));
      await page.mouse.move(900, 700);
    },
  },
  {
    id: "NP-PG-02", section: PG, slug: "cover", title: "Page cover with its controls", viewports: ["desktop", "phone"],
    look: "Cover band above the title; hover shows Change / Reposition / Remove. Title and icon overlap rhythm vs Notion.",
    url: fx("notion-media"),
    setup: async (page, c) => {
      await vis(editor(page));
      await page.locator(".document-page-header").hover();
      await page.getByRole("button", { name: "Add cover" }).click();
      await vis(page.locator(".document-cover"));
      if (!c.phone) await page.locator(".document-cover").hover();
    },
  },
  {
    id: "NP-PG-02", section: PG, slug: "cover-picker", title: "Cover picker (gallery / upload / link)", viewports: ["desktop", "phone"], touch: false,
    look: "Page cover dialog: preset gradients, Upload and Link tabs.",
    url: fx("notion-media"),
    setup: async (page) => {
      await vis(editor(page));
      await page.locator(".document-page-header").hover();
      await page.getByRole("button", { name: "Add cover" }).click();
      await vis(page.locator(".document-cover"));
      await page.locator(".document-cover").hover();
      await page.getByRole("button", { name: "Change cover" }).click();
      await vis(page.getByRole("dialog", { name: "Page cover" }));
    },
  },
  {
    id: "NP-PG-04", section: PG, slug: "breadcrumbs", title: "Breadcrumbs with a collapsed trail (… menu open)", viewports: ["desktop", "phone"],
    look: "Full ancestor trail; long trails collapse behind … which opens a menu. No sideways scroll on phone.",
    url: fx("pages-nav", "?open=watersheds"),
    setup: async (page) => {
      const crumbs = page.getByRole("navigation", { name: "Document location" });
      await vis(crumbs.getByRole("button", { name: /Show \d+ more location/ }));
      await crumbs.getByRole("button", { name: /Show \d+ more location/ }).click();
      await vis(page.getByRole("menuitem").first());
    },
  },
  {
    id: "NP-PG-05", section: PG, slug: "properties", title: "Typed properties under the title", viewports: ["desktop", "phone"],
    look: "Property rows under the title (status, priority, person…), quiet labels, Add property. Compare spacing with Notion's property list.",
    url: fx("databases", "?open=page"),
    setup: async (page) => { await vis(page.getByRole("group", { name: "Page properties" }).getByRole("button", { name: "Status: in-progress" })); },
  },
  {
    id: "NP-PG-05", section: PG, slug: "property-select-open", title: "A select property being edited", viewports: ["desktop", "phone"],
    look: "The option picker for a select property: option chips, search, current value marked.",
    url: fx("databases", "?open=page"),
    setup: async (page) => {
      const props = page.getByRole("group", { name: "Page properties" });
      await vis(props.getByRole("button", { name: "Status: in-progress" }));
      await props.getByRole("button", { name: "Status: in-progress" }).click();
      await vis(page.getByRole("dialog", { name: "Choose Status" }));
    },
  },
  {
    id: "NP-PG-07", section: PG, slug: "page-menu", title: "Page ⋯ menu", viewports: ["desktop"],
    look: "Favorite, Copy link, Duplicate, Move to, Lock, style toggles, Export, History, Trash and the page-info footer (words, created, edited).",
    url: fx("pages-nav"),
    setup: async (page) => { await vis(tree(page)); await page.getByRole("button", { name: "Page actions", exact: true }).click(); await vis(page.getByRole("menuitem").first()); },
  },
  {
    id: "NP-PG-08", section: PG, slug: "page-style", title: "Per-page style: full width + small text + serif", viewports: ["desktop", "phone"], touch: false,
    look: "The page fills the width, text is smaller and serif; the title, properties and body stay aligned.",
    url: fx("notion-shell"),
    setup: async (page) => {
      await vis(editor(page));
      for (const name of [/Full width/, /Small text/, /Serif font/]) {
        await page.getByRole("button", { name: "Page actions", exact: true }).click();
        await page.getByRole(/menuitem/).or(page.getByRole("button")).filter({ hasText: name }).first().click();
        await page.waitForTimeout(250);
      }
      await page.keyboard.press("Escape");
      await page.mouse.move(900, 700);
    },
  },
  {
    id: "NP-PG-10", section: PG, slug: "backlinks", title: "Backlinks pill opened", viewports: ["desktop", "phone"],
    look: "“N backlinks” pill under the title opens a list of linking pages with a snippet each.",
    url: fx("notion-shell"),
    setup: async (page) => { await vis(editor(page)); await page.getByRole("button", { name: "2 backlinks" }).click(); await vis(page.getByRole("region", { name: "Pages that link here" })); },
  },
  {
    id: "NP-PG-11", section: PG, slug: "outline", title: "Outline panel", viewports: ["desktop"],
    look: "Heading list with the current section highlighted; indentation by level; panel does not cover the text.",
    url: fx("workspace"),
    setup: async (page) => {
      await vis(editor(page));
      await editor(page).locator("h2").first().click();
      await page.getByRole("button", { name: "Outline", exact: true }).click();
      await vis(page.getByRole("navigation", { name: "Document outline" }));
    },
  },
  {
    id: "NP-PG-12", section: PG, slug: "history-list", title: "Version history list (day groups)", viewports: ["desktop", "phone"],
    look: "Day-grouped versions with author and size change; Load older.",
    url: fx("context-history", "?paged"),
    setup: async (page) => { await vis(page.locator(".prism-context-history button.prism-context-history-row")); },
  },
  {
    id: "NP-PG-12", section: PG, slug: "history-compare", title: "Version viewer: compare and restore", viewports: ["desktop", "phone"],
    look: "Diff vs the current note with added/removed colouring, Full text toggle, Older/Newer stepping, two-step Restore.",
    url: fx("context-history", "?paged"),
    setup: async (page) => {
      await page.locator(".prism-context-history button.prism-context-history-row").first().click();
      await vis(page.getByRole("dialog", { name: "Version history" }));
      await vis(page.getByRole("button", { name: "Full text", exact: true }));
    },
  },
  {
    id: "NP-PG-13", section: PG, slug: "history-attribution", title: "Versions name their author kind", viewports: ["desktop", "phone"],
    look: "Rows read You / another person / Agent revision / Accepted suggestion / Edit by a link guest; unknown writers are not named.",
    url: fx("notion-sharing", "?panel=history"),
    setup: async (page) => { await vis(page.locator(".prism-context-history .prism-context-history-row")); },
  },
  {
    id: "NP-PG-14", section: PG, slug: "empty-starters", title: "Empty-page starters", viewports: ["desktop", "phone"],
    look: "An empty page offers Empty page / Template / Import (and Ask agent where available) under the Untitled title; quiet, not a wall of buttons.",
    url: fx("notion-shell", "?agent"),
    setup: async (page) => {
      await vis(editor(page));
      await page.evaluate(() => (window as any).prismShellUI.getState().openTab("blank", "Untitled", "document"));
      await vis(page.getByRole("group", { name: "Start this page" }));
    },
  },

  /* 2.3 Editor */
  {
    id: "NP-ED-01", section: ED, slug: "block-hover", title: "Block hover: + and ⋮⋮", viewports: ["desktop"],
    look: "Handles sit in the left margin of the hovered block, aligned with its first line, never over the text.",
    url: fx("editor-blocks"),
    setup: async (page) => { await vis(editor(page)); await page.getByText("Echo quote", { exact: true }).hover(); await vis(page.locator(".block-gutter")); },
  },
  {
    id: "NP-ED-02", section: ED, slug: "block-menu", title: "Block menu", viewports: ["desktop", "phone"],
    look: "Searchable menu: Turn into, Color, Duplicate, Copy, Move to, Comment/Ask agent, Delete with shortcut hints. Phone: opened from the caret block's tap target.",
    url: fx("editor-blocks"),
    setup: async (page, c) => {
      await vis(editor(page));
      await clickInto(page, "Bravo paragraph");
      if (c.phone) await page.getByRole("button", { name: "Block actions" }).click();
      else await page.keyboard.press(`${mod}+Shift+/`);
      await vis(page.getByRole("menu", { name: "Block actions" }));
    },
  },
  {
    id: "NP-ED-02", section: ED, slug: "block-menu-turn-into", title: "Block menu → Turn into", viewports: ["desktop"],
    look: "The Turn into submenu lists every block kind with icons; submenu aligned beside its parent.",
    url: fx("editor-blocks"),
    setup: async (page) => {
      await vis(editor(page));
      await clickInto(page, "Bravo paragraph");
      await page.keyboard.press(`${mod}+Shift+/`);
      const menu = page.getByRole("menu", { name: "Block actions" });
      await vis(menu);
      await menu.getByRole("menuitem", { name: "Turn into" }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "NP-ED-03", section: ED, slug: "slash-menu", title: "Slash menu", viewports: ["desktop", "phone"],
    look: "Grouped (Basic blocks, Media, Database, Advanced, Agent), icon + name + hint + shortcut; phone fits the screen with large targets.",
    url: fx("editor-blocks"),
    setup: async (page) => { await newLine(page); await page.keyboard.type("/"); await vis(page.getByRole("listbox", { name: "Insert block" })); },
  },
  {
    id: "NP-ED-03", section: ED, slug: "slash-menu-search", title: "Slash menu filtered (“/ta”)", viewports: ["desktop"],
    look: "Fuzzy search ranks the intended block first; the empty groups disappear.",
    url: fx("editor-blocks"),
    setup: async (page) => { await newLine(page); await page.keyboard.type("/ta"); await vis(page.getByRole("listbox", { name: "Insert block" })); await page.waitForTimeout(200); },
  },
  {
    id: "NP-ED-07", section: ED, slug: "shortcut-sheet", title: "Keyboard shortcuts sheet", viewports: ["desktop"],
    look: "Sections Text formatting, Blocks, Markdown while typing, Find, Navigation, Databases; key caps readable in both themes.",
    url: fx("editor-blocks"),
    setup: async (page) => { await vis(editor(page)); await page.getByRole("button", { name: "Outline", exact: true }).focus(); await page.keyboard.press(`${mod}+/`); await vis(page.getByRole("dialog", { name: "Keyboard shortcuts" })); },
  },
  {
    id: "NP-ED-08", section: ED, slug: "text-blocks", title: "Every text block type", viewports: ["desktop", "phone"],
    look: "H1–H3, lists, to-dos, toggle, toggle heading, quote, callout, coloured blocks, divider, inline marks. Vertical rhythm and indentation vs Notion.",
    url: fx("editor-blocks", `?content=${enc(ALL_TEXT_BLOCKS)}`),
    setup: async (page) => { await vis(editor(page)); await page.mouse.move(5, 5); },
  },
  {
    id: "NP-ED-10", section: ED, slug: "rich-blocks", title: "Code, table, columns, image, TOC, bookmark, file, embed", viewports: ["desktop", "phone"],
    look: "Code block (language, highlighting), simple table with header row, two columns (stacked on phone), captioned image, table of contents, bookmark card, file card, embed.",
    url: fx("notion-media", `?content=${enc(RICH_BLOCKS)}`),
    setup: async (page) => { await vis(editor(page)); await page.mouse.move(5, 5); await page.waitForTimeout(600); },
  },
  {
    id: "NP-ED-10", section: ED, slug: "rich-blocks-lower", title: "Rich blocks, scrolled to the lower half", viewports: ["desktop", "phone"],
    look: "The blocks below the fold of the previous state: image caption, TOC, bookmark, file, embed.",
    url: fx("notion-media", `?content=${enc(RICH_BLOCKS)}`),
    setup: async (page) => {
      await vis(editor(page));
      await page.waitForTimeout(600);
      await page.getByText("Closing paragraph.", { exact: true }).scrollIntoViewIfNeeded();
      await page.mouse.move(5, 5);
    },
  },
  {
    id: "NP-ED-16", section: ED, slug: "colour-menu", title: "Text colour and highlight menu", viewports: ["desktop"],
    look: "Colour swatches for text and background from the token palette, the last-used colour marked.",
    url: fx("editor-blocks"),
    setup: async (page) => {
      await vis(editor(page));
      await selectText(page, "Bravo paragraph");
      await page.locator(".document-selection-actions:visible").getByRole("button", { name: "Text color and highlight" }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "NP-ED-17", section: ED, slug: "selection-toolbar", title: "Selection toolbar", viewports: ["desktop", "phone"], touch: false,
    look: "Turn into, B/I/U/S/code, Link, Colour, Mention (Comment and Ask agent in live docs) in Notion's order; floats above the selection, on screen at 390 px.",
    url: fx("editor-blocks"),
    setup: async (page) => { await vis(editor(page)); await selectText(page, "Bravo paragraph"); },
  },
  {
    id: "NP-ED-18", section: ED, slug: "link-card", title: "Link card", viewports: ["desktop", "phone"],
    look: "Hover (desktop) or tap (phone) on a link shows its address with Open / Edit / Remove; small, anchored under the link.",
    url: fx("notion-media", `?content=${enc(LINKS)}`),
    setup: async (page, c) => {
      await vis(page.locator(".tiptap").first());
      const link = page.locator(".tiptap a", { hasText: "the docs" }).first();
      if (c.phone) await link.tap(); else await link.hover();
      await vis(page.getByRole("group", { name: "Link", exact: true }));
    },
  },
  {
    id: "NP-ED-18", section: ED, slug: "link-field", title: "Inline link field (⌘K on a selection)", viewports: ["desktop"],
    look: "The inline URL field replaces the toolbar; validation message placement.",
    url: fx("editor-blocks"),
    setup: async (page) => { await vis(editor(page)); await selectText(page, "Bravo paragraph"); await page.keyboard.press(`${mod}+k`); await page.waitForTimeout(300); await page.keyboard.type("example.test/docs"); },
  },
  {
    id: "NP-ED-22", section: ED, slug: "find-replace", title: "Find and replace bar", viewports: ["desktop", "phone"], touch: false,
    look: "Find bar with match count, next/previous, Replace / Replace all; matches highlighted in the text.",
    url: fx("notion-media"),
    setup: async (page) => {
      await vis(editor(page));
      await editor(page).click();
      await page.keyboard.press(`${mod}+Alt+f`);
      await page.waitForTimeout(300);
      await page.keyboard.type("heron");
      await page.waitForTimeout(300);
    },
  },

  /* 2.4 Inline references */
  {
    id: "NP-RF-01", section: RF, slug: "wikilink-autocomplete", title: "[[ page link autocomplete", viewports: ["desktop", "phone"],
    look: "Titles with icon and path; “Create page …” at the end.",
    url: fx("notion-mentions"),
    setup: async (page) => {
      const ed = page.locator(".ProseMirror").first(); await vis(ed); await ed.click();
      await page.keyboard.press(`${mod}+End`); await page.keyboard.press("Enter"); await page.keyboard.type("See [[pro");
      await page.waitForTimeout(700);
    },
  },
  {
    id: "NP-RF-02", section: RF, slug: "mention-menu", title: "@ menu: people, pages, dates", viewports: ["desktop", "phone"],
    look: "Grouped People / Pages / Dates with avatars and icons.",
    url: fx("notion-mentions"),
    setup: async (page) => {
      const ed = page.locator(".ProseMirror").first(); await vis(ed); await ed.click();
      await page.keyboard.press(`${mod}+End`); await page.keyboard.press("Enter"); await page.keyboard.type("Ask @");
      await vis(page.getByRole("option").first());
    },
  },
  {
    id: "NP-RF-03", section: RF, slug: "person-hover-card", title: "Person mention chip + hover card", viewports: ["desktop"],
    look: "Chip style in running text; the hover card shows name, role and linked identities.",
    url: fx("notion-mentions"),
    setup: async (page) => {
      const ed = page.locator(".ProseMirror").first(); await vis(ed); await ed.click();
      await page.keyboard.press(`${mod}+End`); await page.keyboard.press("Enter"); await page.keyboard.type("Ask @ada");
      await page.getByRole("option", { name: /Ada Lovelace/ }).click();
      const chip = ed.locator('[data-type="mention"][data-kind="person"]').last();
      await vis(chip);
      await page.mouse.move(900, 700);
      await chip.hover();
      await vis(page.getByRole("tooltip", { name: "About Ada Lovelace" }));
    },
  },
  {
    id: "NP-RF-05", section: RF, slug: "date-mention", title: "Date mention chip", viewports: ["desktop", "phone"],
    look: "Date chips (“Today”, “Tomorrow”) in running text and the date entries of the @ menu.",
    url: fx("notion-mentions"),
    setup: async (page) => {
      const ed = page.locator(".ProseMirror").first(); await vis(ed); await ed.click();
      await page.keyboard.press(`${mod}+End`); await page.keyboard.press("Enter"); await page.keyboard.type("Due @tomorrow 9am");
      await vis(page.getByRole("option").first());
      await page.keyboard.press("Enter");
      await vis(ed.locator('[data-type="mention"][data-kind="date"]'));
      await ed.locator('[data-type="mention"][data-kind="date"]').last().click();
      await page.waitForTimeout(400);
    },
  },

  /* 2.5 Databases */
  {
    id: "NP-DB-03", section: DB, slug: "table", title: "Table view", viewports: ["desktop", "phone"],
    look: "View tabs, toolbar (Filter, Sort, search, New), typed cells (status chips, dates, numbers, checkbox), row count. Compare density and chip colours with Notion.",
    url: fx("databases"),
    setup: async (page) => { await vis(page.getByRole("table", { name: "All tasks" })); await vis(page.getByText("7 pages")); },
  },
  {
    id: "NP-DB-04", section: DB, slug: "board", title: "Board view", viewports: ["desktop", "phone"],
    look: "Columns per status with counts and “+ New”; cards with properties. Phone: a board opens as its grouped list first, with “Show as board”.",
    url: fx("databases"),
    setup: async (page) => { await vis(page.getByRole("table", { name: "All tasks" })); await page.getByRole("tab", { name: "Board" }).click(); await page.waitForTimeout(500); },
  },
  {
    id: "NP-DB-04", section: DB, slug: "board-card-menu", title: "Board card ⋯ menu", viewports: ["desktop"],
    look: "Card menu (Open, Move to…, order) anchored to its card.",
    url: fx("databases"),
    setup: async (page) => {
      await vis(page.getByRole("table", { name: "All tasks" })); await page.getByRole("tab", { name: "Board" }).click();
      await page.getByRole("button", { name: "Actions for Review workspace navigation" }).click();
      await vis(page.getByRole("menuitem").first());
    },
  },
  {
    id: "NP-DB-05", section: DB, slug: "gallery", title: "Gallery view", viewports: ["desktop", "phone"],
    look: "Cards with cover, title and chosen properties; card size; grid gutters.",
    url: fx("databases"),
    setup: async (page) => { await vis(page.getByRole("table", { name: "All tasks" })); await page.getByRole("tab", { name: "Gallery" }).click(); await vis(page.getByRole("list", { name: "Gallery gallery" })); },
  },
  {
    id: "NP-DB-06", section: DB, slug: "list", title: "List view", viewports: ["desktop", "phone"],
    look: "Compact rows with chosen properties right-aligned.",
    url: fx("databases"),
    setup: async (page) => { await vis(page.getByRole("table", { name: "All tasks" })); await page.getByRole("tab", { name: "List" }).click(); await vis(page.getByRole("list", { name: "List list" })); },
  },
  {
    id: "NP-DB-07", section: DB, slug: "calendar", title: "Calendar view", viewports: ["desktop", "phone"],
    look: "Month grid with today marked, items as chips, multi-day bars, add-on-day affordance.",
    url: fx("databases"),
    setup: async (page) => { await vis(page.getByRole("table", { name: "All tasks" })); await page.getByRole("tab", { name: "Calendar" }).click(); await vis(page.getByRole("grid", { name: "Calendar calendar" })); },
  },
  {
    id: "NP-DB-13", section: DB, slug: "filter", title: "Filter with a condition (phone: sheet)", viewports: ["desktop", "phone"],
    look: "Filter popover/sheet: property, operator, value, Add filter / Add group; the table already narrowed behind it.",
    url: fx("databases"),
    setup: async (page) => {
      await vis(page.getByRole("table", { name: "All tasks" }));
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      const filter = page.getByRole("dialog", { name: "Filter" });
      await vis(filter);
      await filter.getByRole("button", { name: "Add filter" }).click();
      await filter.getByLabel("Condition 1 property").selectOption("priority");
      await filter.getByLabel("Filter value").first().selectOption("high");
      await page.waitForTimeout(400);
    },
  },
  {
    id: "NP-DB-15", section: DB, slug: "view-settings", title: "View settings", viewports: ["desktop", "phone"],
    look: "View settings: name, layout, group by, visible properties, card size, delete view.",
    url: fx("databases"),
    setup: async (page) => {
      await vis(page.getByRole("table", { name: "All tasks" }));
      await page.getByRole("button", { name: "View settings" }).click();
      await vis(page.getByRole("dialog", { name: "View settings" }));
    },
  },
  {
    id: "NP-DB-18", section: DB, slug: "row-peek", title: "Row opened as a side peek (phone: full page)", viewports: ["desktop", "phone"],
    look: "Side peek: title, properties, body; Open as page; the table stays visible behind. Phone opens the row as a page.",
    url: fx("databases"),
    setup: async (page, c) => {
      await vis(page.getByRole("table", { name: "All tasks" }));
      await page.getByRole("button", { name: "Refine onboarding copy", exact: true }).click();
      if (!c.phone) await vis(page.getByRole("dialog", { name: "Refine onboarding copy (side peek)" }));
      await vis(page.getByText("Refine onboarding copy — fictional task."));
    },
  },
  {
    id: "NP-DB-21", section: DB, slug: "bulk-actions", title: "Rows selected: bulk bar", viewports: ["desktop"],
    look: "Selected rows tinted, the bulk bar with count, Edit property, Duplicate, Trash.",
    url: fx("databases"),
    setup: async (page) => {
      const table = page.getByRole("table", { name: "All tasks" });
      await vis(table);
      await table.getByRole("checkbox", { name: "Select Refine onboarding copy" }).click();
      await table.getByRole("checkbox", { name: "Select Update pricing page" }).click({ modifiers: ["Shift"] });
      await vis(page.getByRole("toolbar", { name: "Selected pages" }));
      await page.waitForTimeout(300);
    },
  },
  {
    id: "NP-DB-23", section: DB, slug: "phone-table-scrolled", title: "Phone table scrolled sideways: sticky first column", viewports: ["phone"],
    look: "The title column stays put while the others scroll under it; no page overflow; clear edge shadow.",
    url: fx("databases"),
    setup: async (page) => {
      await vis(page.getByRole("button", { name: "Review workspace navigation", exact: true }));
      await page.locator(".db-table-wrap").first().evaluate((el) => { el.scrollLeft = 260; });
      await page.waitForTimeout(300);
    },
  },
  {
    id: "NP-DB-24", section: DB, slug: "task-board", title: "Task board (existing boards)", viewports: ["desktop", "phone"],
    look: "Per-column “+ Add task”, card ⋯, due chips (overdue colour), Ungrouped column, scroller fades.",
    url: fx("boards"),
    setup: async (page) => { await vis(page.getByRole("region", { name: "Ungrouped", exact: true })); },
  },
  {
    id: "NP-DB-02", section: DB, slug: "inline-database", title: "Inline database block in a page", viewports: ["desktop", "phone"],
    look: "A database view embedded between paragraphs: its toolbar scale, width and borders inside the page column.",
    url: fx("databases", "?block"),
    setup: async (page) => { await vis(page.locator("[data-prism-database]")); await page.waitForTimeout(800); },
  },

  /* 2.6 Collaboration */
  {
    id: "NP-CO-01", section: CO, slug: "inline-comment", title: "Inline comment thread", viewports: ["desktop", "phone"],
    look: "Highlighted anchor in the text, the thread card in the margin (phone: below/sheet) with author, time, Reply, Resolve.",
    url: fx("notion-mentions", "?comments"),
    setup: async (page) => {
      const ed = page.locator(".ProseMirror").first();
      await vis(ed); await ed.click();
      await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout plan"));
      await page.getByRole("button", { name: "Comment on selection" }).click();
      const box = page.getByRole("textbox", { name: "Comment" });
      await vis(box);
      await box.fill("Can we move this a week earlier?");
      await page.keyboard.press(`${mod}+Enter`);
      await page.waitForTimeout(600);
    },
  },
  {
    id: "NP-CO-02", section: CO, slug: "page-discussion", title: "Page-level discussion", viewports: ["desktop", "phone"],
    look: "A discussion under the title, not anchored to text: comment card, reply field. (The fixture shows two people's views side by side.)",
    url: fx("notion-comments"),
    setup: async (page) => {
      const mine = page.getByRole("main", { name: "Your view" }).getByRole("region", { name: "Page discussion" });
      await mine.getByRole("button", { name: "Add comment" }).click();
      await mine.getByRole("textbox", { name: "Comment on this page" }).fill("Should this page move to the handbook?");
      await page.keyboard.press(`${mod}+Enter`);
      await vis(mine.locator("[data-comment-id]"));
    },
  },
  {
    id: "NP-CO-03", section: CO, slug: "inbox", title: "Inbox", viewports: ["desktop", "phone"],
    look: "Day groups, unread dots, mention / reply / share rows with page titles, filters, Mark all read.",
    url: fx("notion-inbox", "?reset&open=notifications"),
    setup: async (page) => { await vis(page.getByTestId("notifications-inbox")); await vis(page.getByTestId("notification-row")); },
  },
  {
    id: "NP-CO-05", section: CO, slug: "share-people", title: "Share dialog — People", viewports: ["desktop", "phone"],
    look: "Underline tabs, invite field with level, owner row, named people with avatars and scope (“Includes sub-pages”), inherited access with its source.",
    url: fx("sharing", "?page"),
    setup: async (page) => { await openShare(page); await vis(page.getByRole("dialog", { name: "Share document" }).locator("[data-share-owner]")); },
  },
  {
    id: "NP-CO-06", section: CO, slug: "share-link", title: "Share dialog — Link access", viewports: ["desktop", "phone"],
    look: "Restricted vs anyone-with-link, level and expiry selects, Create link, existing links with Copy / Revoke.",
    url: fx("sharing", "?page"),
    setup: async (page) => { await openShare(page); await page.getByRole("dialog", { name: "Share document" }).getByRole("tab", { name: "Link access", exact: true }).click(); await page.waitForTimeout(300); },
  },
  {
    id: "NP-CO-08", section: CO, slug: "share-publish", title: "Share dialog — Publish", viewports: ["desktop", "phone"],
    look: "Explains per-tag publishing, lists the pages you can see with the tag, hands off to the Publishing studio.",
    url: fx("sharing", "?page"),
    setup: async (page) => { await openShare(page); await page.getByRole("dialog", { name: "Share document" }).getByRole("tab", { name: "Publish", exact: true }).click(); await page.waitForTimeout(300); },
  },
  {
    id: "NP-CO-08", section: CO, slug: "publication-page", title: "A published page (public wiki)", viewports: ["desktop", "phone"],
    look: "The public reader: site nav, page typography, callouts/toggles/tables rendered read-only; follows the workspace palette in both themes.",
    url: fx("publication", "?blocks"),
    setup: async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(800); },
  },
  {
    id: "NP-CO-11", section: CO, slug: "presence", title: "Presence avatars and a collaborator's caret", viewports: ["desktop", "phone"], realServer: true, touch: false,
    look: "Avatar of the other person in the header; their named caret in the text. Phone: one compact count.",
    url: fx("collab-route", "?target=plan"),
  },
  {
    id: "NP-CO-12", section: CO, slug: "suggestion-marks", title: "Suggested edits in the text", viewports: ["desktop", "phone"],
    look: "Insertions and deletions marked in the author's colour; the “N suggested changes” entry point.",
    url: fx("suggestion-review"),
    setup: async (page) => { await vis(page.getByText("3 suggested changes", { exact: true })); },
  },
  {
    id: "NP-CO-12", section: CO, slug: "suggestion-review", title: "Focused suggestion review", viewports: ["desktop", "phone"],
    look: "Change N of M, author, before/after, Accept / Decline, Show in document; the change highlighted in the text.",
    url: fx("suggestion-review"),
    setup: async (page) => { await page.getByText("3 suggested changes", { exact: true }).click(); await vis(page.getByRole("region", { name: "Change by Prism agent" })); },
  },
  {
    id: "NP-CO-13", section: CO, slug: "request-access", title: "No access → Request access", viewports: ["desktop", "phone"],
    look: "“Document unavailable” with no title or content leaked, one clear Request access action.",
    url: fx("notion-inbox", "?reset&as=member&open=secret"),
    setup: async (page) => { await vis(page.locator("#workspace-document").getByRole("heading", { name: "Document unavailable" })); },
  },
  {
    id: "NP-CO-13", section: CO, slug: "access-request-inbox", title: "Owner sees the access request in the Inbox", viewports: ["desktop", "phone"],
    look: "The request row with requester, page and Approve (with level) / Deny.",
    url: fx("notion-inbox", "?reset&as=member&open=secret"),
    setup: async (page) => {
      const main = page.locator("#workspace-document");
      await vis(main.getByRole("heading", { name: "Document unavailable" }));
      await main.getByRole("button", { name: "Request access" }).click();
      await main.getByRole("status").filter({ hasText: /Request sent/ }).waitFor();
      await page.goto(fx("notion-inbox", "?as=owner&open=notifications"));
      await vis(page.getByTestId("notification-row").filter({ hasText: "requested access" }));
    },
  },
  {
    id: "NP-CO-15", section: CO, slug: "page-updates", title: "Page updates feed", viewports: ["desktop", "phone"],
    look: "Edits (with author), comments, shares, agent revisions in one newest-first list.",
    url: fx("notion-sharing", "?panel=history"),
    setup: async (page) => { await page.getByRole("tab", { name: "Updates" }).click(); await vis(page.getByLabel("Page updates").locator("li")); },
  },

  /* 2.7 Search */
  {
    id: "NP-SR-01", section: SR, slug: "palette-recents", title: "⌘K before typing: recent pages", viewports: ["desktop", "phone"],
    look: "Recent pages first with icons and edited dates, then commands with shortcut hints. Phone: full-screen search.",
    url: fx("pages-nav", `?prefs=${enc(JSON.stringify({ recents: ["week1", "archive"] }))}`),
    setup: async (page, c) => { await vis(c.phone ? page.getByRole("navigation", { name: "Mobile workspace" }) : tree(page).getByRole("button", { name: "Prism", exact: true })); const d = await palette(page, c); await vis(d.getByRole("group", { name: "Recent pages" })); },
  },
  {
    id: "NP-SR-02", section: SR, slug: "results-grouped", title: "Results grouped by kind, with the kind filter", viewports: ["desktop", "phone"],
    look: "Notes / Messages / Commands groups, All/Notes/Messages filter, “N results shown”, snippet lines.",
    url: fx("search", "?many"),
    setup: async (page) => {
      await page.getByRole("button", { name: "Open search", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Search workspace" });
      await dialog.getByRole("combobox").fill("Prism");
      await dialog.getByText("11 results shown").waitFor();
    },
  },
  {
    id: "NP-SR-03", section: SR, slug: "match-highlight", title: "Matched terms highlighted", viewports: ["desktop", "phone"],
    look: "The query is highlighted in titles and snippets; highlight colour readable in both themes.",
    url: fx("notion-shell"),
    setup: async (page, c) => {
      await vis(editor(page));
      const d = await palette(page, c);
      await d.getByRole("combobox").fill("workshop");
      await vis(d.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Workshop agenda/ }));
      await page.waitForTimeout(500);
    },
  },
  {
    id: "NP-SR-04", section: SR, slug: "search-filters", title: "Search filters", viewports: ["desktop", "phone"],
    look: "Title only, type, created/edited by me, date, vault scope — one quiet row under the field.",
    url: fx("notion-shell", "?vaults"),
    setup: async (page, c) => {
      await vis(editor(page));
      const d = await palette(page, c);
      await d.getByRole("combobox").fill("workshop");
      await vis(d.getByRole("option").first());
      const toggle = d.getByRole("button", { name: /Filters?/ }).first();
      if (await toggle.count()) await toggle.click();
      await page.waitForTimeout(400);
    },
  },

  /* 2.8 Templates, import, export */
  {
    id: "NP-TX-01", section: TX, slug: "new-from-template", title: "New page → from a template", viewports: ["desktop", "phone"],
    look: "The New page chooser: page types and templates, Manage templates…",
    url: fx("notion-transfer"),
    setup: async (page, c) => { const n = await navigation(page, c); await n.getByRole("button", { name: "New page from template", exact: true }).click(); await vis(page.getByRole("dialog", { name: "New page", exact: true })); },
  },
  {
    id: "NP-TX-01", section: TX, slug: "templates-gallery", title: "Templates gallery", viewports: ["desktop", "phone"],
    look: "Template rows with name and edited date; Use, Edit, Rename, Share/Make private, Delete.",
    url: fx("notion-transfer"),
    setup: async (page, c) => {
      const n = await navigation(page, c);
      await n.getByRole("button", { name: "New page from template", exact: true }).click();
      await page.getByRole("dialog", { name: "New page", exact: true }).getByRole("button", { name: "Manage templates…" }).click();
      await vis(page.getByRole("dialog", { name: /Templates/ }).getByRole("listitem"));
    },
  },
  {
    id: "NP-TX-03", section: TX, slug: "export-page", title: "Export a page", viewports: ["desktop", "phone"],
    look: "Format (Markdown / HTML / PDF), Sub-pages and Images-and-files toggles, Export.",
    url: fx("notion-transfer"),
    setup: async (page, c) => {
      await vis(c.phone ? page.getByRole("navigation", { name: "Mobile workspace" }) : tree(page));
      await page.getByRole("button", { name: "Page actions", exact: true }).click();
      await page.getByRole(c.phone ? "button" : "menuitem", { name: /^Export…/ }).first().click();
      await vis(page.getByRole("dialog", { name: /Export/ }));
    },
  },
  {
    id: "NP-TX-04", section: TX, slug: "export-workspace", title: "Export the workspace", viewports: ["desktop"],
    look: "Markdown / HTML, Images and files; what the export contains (your view).",
    url: fx("notion-transfer"),
    setup: async (page, c) => { await vis(tree(page)); await runCommand(page, c, "Export Workspace…"); await vis(page.getByRole("dialog", { name: "Export workspace" })); },
  },
  {
    id: "NP-TX-05", section: TX, slug: "import-pick", title: "Import — choose a file", viewports: ["desktop", "phone"],
    look: "File picker, destination folder, what formats are accepted; Preview import disabled until a file is chosen.",
    url: fx("notion-transfer"),
    setup: async (page, c) => { await vis(c.phone ? page.getByRole("navigation", { name: "Mobile workspace" }) : tree(page)); await runCommand(page, c, "Import… (Markdown, HTML, CSV, Notion)"); await vis(page.getByRole("dialog", { name: "Import", exact: true })); },
  },
  {
    id: "NP-TX-05", section: TX, slug: "import-preview", title: "Import — dry-run summary", viewports: ["desktop", "phone"],
    look: "“Nothing has been imported yet”, what the file contains, each page with New / Updated / Conflict, then Import.",
    url: fx("notion-transfer"),
    setup: async (page, c) => {
      await vis(c.phone ? page.getByRole("navigation", { name: "Mobile workspace" }) : tree(page));
      await runCommand(page, c, "Import… (Markdown, HTML, CSV, Notion)");
      const dialog = page.getByRole("dialog", { name: "Import", exact: true });
      await vis(dialog);
      await dialog.getByLabel("File to import").setInputFiles({ name: IMPORT_FILE.name, mimeType: IMPORT_FILE.mimeType, buffer: Buffer.from(IMPORT_FILE.text) });
      await dialog.getByRole("button", { name: "Preview import" }).click();
      await vis(dialog.getByTestId("import-preview"));
    },
  },

  /* 2.9 Agent */
  {
    id: "NP-AI-01", section: AI, slug: "agent-panel", title: "Agent conversation", viewports: ["desktop", "phone"],
    look: "Conversation title, working document, permissions select, turns with tool chips, composer. Phone: full-screen layer.",
    url: fx("agent", "?history&permissions&visual"),
    setup: async (page) => { await vis(page.getByTestId("agent-conversation-title")); await vis(page.getByRole("textbox", { name: "Message the agent" })); },
  },
  {
    id: "NP-AI-01", section: AI, slug: "selection-ask", title: "Selection attached to the agent as an unsent draft", viewports: ["desktop"],
    look: "The selected passage shown as an attachment chip in the composer; nothing sent yet.",
    url: fx("agent", "?context&snapshots&selection"),
    setup: async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(800); },
  },
  {
    id: "NP-AI-03", section: AI, slug: "page-agent-proposal", title: "Summarize page → proposal with sources", viewports: ["desktop", "phone"],
    look: "Non-modal panel (phone: bottom sheet): the result, Sources, “It did not change the page”, Insert at top / at end / Copy / Discard.",
    url: fx("notion-page-agent", "?open=brief"),
    setup: async (page, c) => {
      await vis(page.locator("#workspace-document .tiptap"));
      await page.getByRole("button", { name: "Page actions", exact: true }).click();
      await page.getByRole(c.phone ? "button" : "menuitem", { name: "Summarize page", exact: true }).first().click();
      await vis(page.getByRole("dialog", { name: /^Agent · / }).getByRole("region", { name: "Agent result" }));
    },
  },
  {
    id: "NP-AI-03", section: AI, slug: "selection-ai-menu", title: "Selection toolbar → AI menu", viewports: ["desktop"],
    look: "The AI actions for a selection (improve, shorten, tone, translate…) as a menu off the toolbar.",
    url: fx("notion-page-agent", "?open=brief"),
    setup: async (page) => {
      const doc = page.locator("#workspace-document .tiptap").first();
      await vis(doc);
      await doc.locator("p").first().click({ clickCount: 3 });
      const b = page.getByRole("button", { name: "Agent actions for the selection", exact: true });
      await vis(b); await b.click();
      await page.waitForTimeout(300);
    },
  },

  /* 2.10 Phone */
  {
    id: "NP-MB-01", section: MB, slug: "bottom-bar", title: "Phone bottom bar with the Inbox badge", viewports: ["phone"],
    look: "Five labelled destinations (Notes · Inbox · Search · Agent · More), badge on Inbox, safe-area padding, nothing overlapping the page.",
    url: fx("notion-shell", "?inbox&agent"),
    setup: async (page) => { await vis(page.getByRole("navigation", { name: "Mobile workspace" })); await vis(editor(page)); },
  },
  {
    id: "NP-MB-01", section: MB, slug: "more-sheet", title: "Phone More sheet", viewports: ["phone"],
    look: "Bottom sheet with the remaining destinations and page actions; 44 px rows; grabber and rounded top.",
    url: fx("notion-shell", "?inbox&agent"),
    setup: async (page) => { const bar = page.getByRole("navigation", { name: "Mobile workspace" }); await vis(bar); await vis(editor(page)); await bar.getByRole("button", { name: "More", exact: true }).click(); await page.waitForTimeout(400); },
  },
  {
    id: "NP-MB-03", section: MB, slug: "page-actions-sheet", title: "Phone page actions sheet", viewports: ["phone"],
    look: "Every page action as a 44 px row in a sheet titled with the page name.",
    url: fx("pages-nav"),
    setup: async (page) => { await vis(page.getByRole("navigation", { name: "Mobile workspace" })); await page.getByRole("button", { name: "Page actions", exact: true }).click(); await vis(page.getByRole("dialog", { name: "A living workspace" })); },
  },
  {
    id: "NP-MB-04", section: MB, slug: "keyboard-toolbar", title: "Phone editing toolbar above the keyboard", viewports: ["phone"],
    look: "Insert block, Turn into, B/I/U/S, Link, To-do, Indent/Outdent, Mention, Image, Undo/Redo, Dismiss — one scrollable row riding on the keyboard; bottom bar hidden.",
    url: fx("notion-shell"),
    setup: async (page) => {
      await vis(editor(page));
      await editor(page).locator("p").first().tap();
      await vis(page.getByRole("toolbar", { name: "Editing toolbar" }));
    },
  },
  {
    id: "NP-MB-07", section: MB, slug: "browse-drawer", title: "Phone Browse drawer", viewports: ["phone"],
    look: "Vault switcher, Favorites, Recent, the page tree, Tools, Trash, New page, Settings — 44 px rows, no sideways scroll.",
    url: fx("pages-nav", `?prefs=${enc(JSON.stringify({ favorites: ["plan"], recents: ["week1", "archive"] }))}`),
    setup: async (page, c) => { const d = await navigation(page, c); await vis(d.getByRole("region", { name: "Pages", exact: true }).getByRole("button", { name: "Prism", exact: true })); },
  },
  {
    id: "NP-MB-07", section: MB, slug: "browse-drawer-bottom", title: "Phone Browse drawer, scrolled to its end", viewports: ["phone"],
    look: "The foot of the drawer: Tools, Trash, sync state, Settings — nothing hidden under the home indicator.",
    url: fx("pages-nav", `?prefs=${enc(JSON.stringify({ favorites: ["plan"], recents: ["week1", "archive"] }))}`),
    setup: async (page, c) => {
      const d = await navigation(page, c);
      await vis(d.getByRole("region", { name: "Pages", exact: true }).getByRole("button", { name: "Prism", exact: true }));
      await d.getByRole("button", { name: "Trash", exact: true }).scrollIntoViewIfNeeded();
      await d.evaluate((el) => { for (const n of [el, ...Array.from(el.querySelectorAll("*"))]) if (n.scrollHeight > n.clientHeight + 4) (n as HTMLElement).scrollTop = n.scrollHeight; });
      await page.waitForTimeout(300);
    },
  },

  /* 2.11 Offline */
  {
    id: "NP-OF-01", section: OF, slug: "save-failed", title: "Header: Save failed · Retry", viewports: ["desktop", "phone"], touch: false,
    look: "The header badge turns into a Retry button with a clear failed colour; the draft is still in the page.",
    url: fx("notion-shell"),
    setup: async (page, c) => {
      await vis(editor(page));
      await page.evaluate(() => { (window as any).prismShell.failStatus = 422; });
      await typeAtEnd(page, " Refused edit.");
      await page.getByRole("button", { name: /Save failed/ }).first().waitFor({ timeout: 12_000 });
      if (c.phone) await page.keyboard.press("Escape");
    },
  },
  {
    id: "NP-OF-01", section: OF, slug: "offline", title: "Header: offline, changes saved on this device", viewports: ["desktop", "phone"], touch: false,
    look: "Offline state in the header (phone: the compact dot + text). Never reads Saved.",
    url: fx("notion-shell"),
    setup: async (page, c) => {
      await vis(editor(page));
      await c.context.setOffline(true);
      await typeAtEnd(page, " Offline edit.");
      await page.locator(".sync-state-header, .sync-state-phone", { hasText: /Offline|this device/ }).first().waitFor({ timeout: 12_000 });
    },
  },
  {
    id: "NP-OF-06", section: OF, slug: "saved-changes-dialog", title: "Unsent changes dialog", viewports: ["desktop", "phone"], touch: false,
    look: "The list of changes waiting on this device with Retry / Discard / Download.",
    url: fx("notion-shell"),
    setup: async (page, c) => {
      await vis(editor(page));
      await c.context.setOffline(true);
      await typeAtEnd(page, " Offline edit.");
      await page.locator(".sync-state-header, .sync-state-phone", { hasText: /Offline|this device/ }).first().waitFor({ timeout: 12_000 });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:open-saved-changes")));
      await page.waitForTimeout(500);
    },
  },

  /* Other surfaces */
  {
    id: "X-SETTINGS", section: OTHER, slug: "workspace-settings", title: "Workspace settings", viewports: ["desktop", "phone"],
    look: "Tabs, section cards, form rows; phone: tabs scroll, nothing wider than the screen.",
    url: fx("workspace-settings"),
    setup: async (page) => { await vis(page.getByRole("heading", { name: "Workspace settings", exact: true })); },
  },
  {
    id: "X-SETTINGS", section: OTHER, slug: "app-settings", title: "App settings (⌘,)", viewports: ["desktop", "phone"], touch: false,
    look: "Settings dialog: Appearance (theme, fonts, Reduce motion), Account, devices.",
    url: fx("notion-shell", "?account"),
    setup: async (page) => {
      await vis(editor(page));
      await page.evaluate(() => (window as any).prismShellUI.getState().setSettingsOpen(true));
      await page.waitForTimeout(700);
    },
  },
  {
    id: "X-PEOPLE", section: OTHER, slug: "people-profile", title: "Person profile", viewports: ["desktop", "phone"],
    look: "A person page: identities, recent threads, meetings, tasks.",
    url: fx("people-profile"),
    setup: async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(600); },
  },
  {
    id: "X-CALENDAR", section: OTHER, slug: "calendar", title: "Calendar dashboard", viewports: ["desktop", "phone"],
    look: "The Tools → Calendar destination.",
    url: fx("calendar"),
    setup: async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(600); },
  },
  {
    id: "X-MESSAGES", section: OTHER, slug: "messages", title: "Messages", viewports: ["desktop", "phone"],
    look: "The Messages destination: thread list and reading pane.",
    url: fx("messages"),
    setup: async (page) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(600); },
  },
];
