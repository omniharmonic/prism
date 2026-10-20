import { test, expect, type Page } from "@playwright/test";

/**
 * Polish round 2, navigation (the owner's first iPhone run):
 *  1. the phone bar's title is centred in the BAR for every view — Messages (no controls on the
 *     right) sat 34 px right of centre, because the title was centred in what the controls left;
 *  2. choosing a FOLDER from the page-name drop-down (or a breadcrumb) opens the sidebar — on a
 *     phone the Browse drawer — with that folder expanded, scrolled into view and focused;
 *     a PAGE in the trail opens (that is the way back to a parent page);
 *  4a. a new sub-page has a visible way back to its parent on a phone and on a desktop.
 */
const PHONE = { width: 390, height: 844 };
const ui = (page: Page) => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId as string; });
const openTab = (page: Page, id: string, title: string, type = "document") => page.evaluate(([id, title, type]) => (window as any).prismShellUI.getState().openTab(id, title, type), [id, title, type]);
/** The focused tree row, and whether it is inside the sidebar's visible scroll area. */
const focusedRow = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.classList.contains("page-tree-open")) return null;
  const r = el.getBoundingClientRect();
  let scroller: HTMLElement | null = el.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const box = scroller?.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { name: el.textContent, expanded: el.closest('[role="treeitem"]')?.getAttribute("aria-expanded"), inView: !!box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1, onTop: !!hit && el.contains(hit), scrolled: scroller?.scrollTop ?? 0 };
});

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("the bar's title is centred in the bar for every virtual tab, and as near as its controls allow for a page", async ({ page }, info) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const title = page.locator(".tabbar-phone-title");
    const offCentre = () => title.evaluate((el) => { const r = el.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2); });
    for (const [id, name] of [["messages-dashboard", "Messages"], ["calendar-dashboard", "Calendar"], ["home", "Home"], ["people", "People"], ["agent-activity", "Agent activity"], ["notifications", "Inbox"]]) {
      await openTab(page, id!, name!, id);
      await expect(title).toHaveText(name!);
      expect(await offCentre(), `${name} is centred in the bar`).toBeLessThanOrEqual(1);
      if (id === "messages-dashboard") await page.screenshot({ path: info.outputPath("phone-bar-messages.png"), clip: { x: 0, y: 0, width: 390, height: 60 } });
    }
    // A page has four controls on the right, more than half the bar with a long name: the name keeps
    // every pixel between the two sides (never under a control), as near the centre as they allow.
    await openTab(page, "workspace", "A living workspace");
    await expect(title).toContainText("A living workspace");
    const layout = await page.evaluate(() => {
      const t = document.querySelector(".tabbar-phone-title")!;
      const box = t.getBoundingClientRect();
      const back = document.querySelector('button[title="Back"]')!.getBoundingClientRect();
      const forward = document.querySelector('button[title="Forward"]')!.getBoundingClientRect();
      const sides = [...document.querySelectorAll(".tabbar-phone-side")].map((el) => el.getBoundingClientRect());
      return { left: box.left, right: box.right, forwardRight: forward.right, backLeft: back.left, endLeft: sides[1]!.left, endRight: sides[1]!.right, vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.left).toBeGreaterThanOrEqual(layout.forwardRight);
    expect(layout.right).toBeLessThanOrEqual(layout.endLeft + 1);
    expect(layout.endRight).toBeLessThanOrEqual(layout.vw);
    expect(layout.overflow).toBe(false);
    for (const name of ["Back", "Forward", "Add to Favorites", "Share", "Page actions"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("phone-bar-page.png"), clip: { x: 0, y: 0, width: 390, height: 60 } });
    // A top-level page with a short name has room on both sides: centred.
    await page.evaluate(() => (window as any).prismShell.serverCreate("Notes", "<p>Short.</p>"));
    await openTab(page, "foreign-1", "Notes");
    await expect(title).toHaveText("Notes");
    expect(await offCentre(), "a short page name is centred").toBeLessThanOrEqual(1);
  });

  test("a folder chosen from the page-name drop-down opens the Browse drawer on that folder: expanded, in view, focused", async ({ page }, info) => {
    await page.goto("/e2e-fixtures/notion-shell.html?manyfolders");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
    await page.getByRole("button", { name: "A living workspace — show 2 locations" }).click();
    const menu = page.getByRole("menu", { name: "Locations" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Projects", "Prism"]);
    await menu.getByRole("menuitem", { name: "Prism" }).click();
    await expect(drawer).toBeVisible();
    // "Prism" is forty rows down: it was scrolled to, it has the focus, and it is open.
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Prism");
    const row = (await focusedRow(page))!;
    expect(row).toMatchObject({ expanded: "true", inView: true, onTop: true });
    expect(row.scrolled).toBeGreaterThan(200);
    await expect(drawer.getByRole("treeitem", { name: "A living workspace" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("phone-reveal-folder.png") });
    // The page stays where it was (a folder has nothing to open), and the keyboard walks on from the row.
    expect(await ui(page)).toBe("workspace");
    // The outer folder too, from a closed drawer again.
    await drawer.getByRole("button", { name: "Close navigation" }).click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole("button", { name: "A living workspace — show 2 locations" }).click();
    await menu.getByRole("menuitem", { name: "Projects" }).click();
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Projects");
    expect(await focusedRow(page)).toMatchObject({ expanded: "true", inView: true, onTop: true });
  });

  test("a folded Pages section opens for the revealed folder", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(drawer).toBeVisible();
    const pages = drawer.getByRole("button", { name: "Pages", exact: true });
    await pages.click();
    await expect(pages).toHaveAttribute("aria-expanded", "false");
    await drawer.getByRole("button", { name: "Close navigation" }).click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole("button", { name: "A living workspace — show 2 locations" }).click();
    await page.getByRole("menu", { name: "Locations" }).getByRole("menuitem", { name: "Prism" }).click();
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Prism");
    await expect(drawer.getByRole("button", { name: "Pages", exact: true })).toHaveAttribute("aria-expanded", "true");
  });

  test("a new sub-page leads back to its parent: the drop-down lists the parent page and opens it", async ({ page }) => {
    await page.goto("/e2e-fixtures/notion-shell.html");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await expect(editor).toBeVisible();
    await editor.locator("p").first().tap();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/page");
    await page.getByRole("option", { name: /^Page Add a sub-page/ }).click();
    const row = page.getByRole("button", { name: "Open sub-page: Untitled" });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => (window as any).prismShell.writes.filter((w: any) => w.method === "POST" && w.path === "/api/notes").map((w: any) => w.body.path))).toEqual(["Projects/Prism/A living workspace/Untitled"]);
    await row.click();
    await expect.poll(() => ui(page)).toBe("created-1");
    // The sub-page's name is the control; its trail ends with the parent PAGE.
    await page.getByRole("button", { name: "Untitled — show 3 locations" }).click();
    const menu = page.getByRole("menu", { name: "Locations" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Projects", "Prism", "A living workspace"]);
    await menu.getByRole("menuitem", { name: "A living workspace" }).click();
    // A page in the trail OPENS (no drawer over it); Back returns to the sub-page.
    await expect.poll(() => ui(page)).toBe("workspace");
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open sub-page: Untitled" })).toBeVisible();
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a folder crumb opens the sidebar on that folder — collapsed or open, from the trail or its “…” menu", async ({ page }, info) => {
    await page.goto("/e2e-fixtures/notion-shell.html?manyfolders&collapsed");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Document location" });
    const tree = page.getByRole("tree", { name: "Pages" });
    await expect(tree).toHaveCount(0);
    await crumbs.getByRole("button", { name: "Prism" }).click();
    await expect(tree).toBeVisible();
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Prism");
    const row = (await focusedRow(page))!;
    expect(row).toMatchObject({ expanded: "true", inView: true, onTop: true });
    expect(row.scrolled).toBeGreaterThan(200);
    expect(await page.evaluate(() => (window as any).prismShellUI.getState().sidebarOpen)).toBe(true);
    await page.screenshot({ path: info.outputPath("desktop-reveal-folder.png") });
    // With the sidebar already open and scrolled away: the row is brought back and focused.
    await tree.evaluate((el) => { let s: HTMLElement | null = el as HTMLElement; while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement; s!.scrollTop = 0; });
    await page.locator(".tiptap").click();
    await crumbs.getByRole("button", { name: "Projects" }).click();
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Projects");
    expect(await focusedRow(page)).toMatchObject({ inView: true, onTop: true });
    // A deep sub-page: a hidden FOLDER in the “…” menu reveals; the parent PAGE crumb opens.
    await page.evaluate(() => (window as any).prismShell.serverCreate("Projects/Prism/A living workspace/Decisions/Budget", "<p>Numbers.</p>"));
    await openTab(page, "foreign-1", "Budget");
    await expect(crumbs).toHaveCount(1);
    await page.locator(".tiptap").click();
    // (With the sidebar open the trail has folded: "…" holds some or all of it.)
    await crumbs.getByRole("button", { name: /^Show \d+ (more )?locations?$/ }).click();
    await page.getByRole("menu", { name: "More locations" }).getByRole("menuitem", { name: "Prism" }).click();
    await expect.poll(async () => (await focusedRow(page))?.name).toBe("Prism");
    expect(await ui(page)).toBe("foreign-1");
    await page.setViewportSize({ width: 1600, height: 800 });
    await crumbs.getByRole("button", { name: "A living workspace" }).click();
    await expect.poll(() => ui(page)).toBe("workspace");
  });
});
