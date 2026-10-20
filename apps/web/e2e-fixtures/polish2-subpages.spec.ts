import { test, expect, type Page } from "@playwright/test";

/**
 * Polish round 2, sub-pages (the owner's first iPhone run): deleting a sub-page's row FROM its
 * parent moves that page to the Trash — no question — and stays safe:
 *  - only a page the deleter's own read shows directly under this page;
 *  - never after a cut, a "Move to", a collaborator's change, a whole-document load, or the undo of
 *    the `/page` that made the row;
 *  - a page that may not be trashed keeps its row deleted, and the app says so;
 *  - undoable: the toast's Undo and the editor's undo both bring the page out of the Trash and the
 *    row back. The Trash, never a permanent delete.
 * (`notion-editor.spec.ts` "child page block appears in parent body" holds the cut / foreign-row cases.)
 */
const enc = encodeURIComponent;
const settle = (page: Page) => page.waitForFunction(() => new Promise((r) => setTimeout(() => r(true), 650)));
const html = (page: Page, i = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, i);
async function selectRow(page: Page, id: string, i = 0) {
  const editor = page.locator(".tiptap").nth(i);
  await editor.focus();
  await expect(editor).toBeFocused();
  await page.evaluate(([id, i]) => {
    const editor = (document.querySelectorAll(".tiptap")[i as number] as any).editor;
    let at = -1;
    editor.state.doc.descendants((n: any, pos: number) => { if (n.type.name === "childPage" && n.attrs.pageId === id) at = pos; });
    editor.commands.setNodeSelection(at);
  }, [id, i] as const);
  await expect.poll(() => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.state.selection.node?.attrs.pageId ?? null, i)).toBe(id);
}

test.describe("the editor (plain and live)", () => {
  const media = (page: Page, query = "") => page.goto(`/e2e-fixtures/notion-media.html${query}`);
  const trashed = (page: Page) => page.evaluate(() => (window as any).prismMediaTrashed as string[]);
  const restored = (page: Page) => page.evaluate(() => (window as any).prismMediaRestored as string[]);
  /** Sub-pages of the fixture's page ("Projects/Prism/Field guide"), in the vault before the app loads. */
  const seedKids = (page: Page, extra: Record<string, unknown> = {}) => page.addInitScript((extra) => {
    const at = "2026-10-02T12:00:00.000Z";
    (window as any).prismMediaSeed = [
      { id: "kid", path: "Projects/Prism/Field guide/Trip plan", content: "", tags: [], metadata: { title: "Trip plan" }, createdAt: at, updatedAt: at, ...extra },
      { id: "kid2", path: "Projects/Prism/Field guide/Packing list", content: "", tags: [], metadata: { title: "Packing list" }, createdAt: at, updatedAt: at },
    ];
  }, extra);
  const kidDoc = `?content=${enc('<p>Top</p><div data-type="child-page" data-page-id="kid"></div><p>Bottom</p>')}`;

  test("undoing the /page that made a row, and a whole-document load, move nothing to the Trash", async ({ page }) => {
    await media(page, `?content=${enc("<p>Top</p>")}`);
    await page.locator(".tiptap").getByText("Top").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/page");
    await page.getByRole("option", { name: /^Page Add a sub-page/ }).click();
    const row = page.locator(".tiptap .prism-child-page[data-state=ready]");
    await expect(row).toHaveCount(1);
    await page.waitForTimeout(650); // the history's own grouping window
    // ⌘Z undoes the insertion (it is not this person deleting a sub-page): the page stays.
    await page.locator(".tiptap").focus();
    for (let i = 0; i < 6 && (await page.locator(".tiptap .prism-child-page").count()) > 0; i++) await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(0);
    await settle(page);
    expect(await trashed(page)).toEqual([]);
    await expect(page.getByText(/to Trash/)).toHaveCount(0);
    // Redo puts the row back; replacing the whole document (a template, an import, an agent's
    // version) is not a deletion of the row either.
    for (let i = 0; i < 6 && (await page.locator(".tiptap .prism-child-page").count()) === 0; i++) await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(row).toHaveCount(1);
    await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.setContent("<p>Replaced by a template.</p>"));
    await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(0);
    await settle(page);
    expect(await trashed(page)).toEqual([]);
  });

  test("a page that may not be trashed: the row is deleted, the page stays, and the app says so", async ({ page }) => {
    // Refused by the gateway (403).
    await seedKids(page);
    await media(page, `${kidDoc}&notrash`);
    await expect(page.locator(".tiptap .prism-child-page[data-state=ready]")).toHaveCount(1);
    await selectRow(page, "kid");
    await page.keyboard.press("Backspace");
    const toast = page.locator(".page-toast");
    await expect(toast).toHaveAttribute("role", "alert");
    await expect(toast).toContainText("The link was removed. “Trip plan” couldn’t be moved to Trash and is still under this page in the sidebar.");
    await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(0);
    expect(await trashed(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).prismMediaVault.find((n: any) => n.id === "kid").tags)).toEqual([]);
    // A system-owned page is never even asked for.
    await seedKids(page, { tags: ["governance-proposal"] });
    await media(page, kidDoc);
    await expect(page.locator(".tiptap .prism-child-page[data-state=ready]")).toHaveCount(1);
    await selectRow(page, "kid");
    await page.keyboard.press("Backspace");
    await expect(toast).toContainText("The link was removed. “Trip plan” was not moved to Trash. Governance records can only change through governance.");
    expect(await trashed(page)).toEqual([]);
  });

  test("several rows deleted at once go to the Trash together; Undo puts each back in its place", async ({ page }) => {
    await seedKids(page);
    await media(page, `?content=${enc('<p>Top</p><div data-type="child-page" data-page-id="kid"></div><p>Middle</p><div data-type="child-page" data-page-id="kid2"></div><div data-type="child-page" data-page-id="b1"></div><p>Bottom</p>')}`);
    await expect(page.locator(".tiptap .prism-child-page[data-state=ready]")).toHaveCount(3);
    await page.locator(".tiptap").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(0);
    const toast = page.locator(".page-toast");
    // "Braiding Sweetgrass" (b1) lives elsewhere — only this page's own two sub-pages go.
    await expect(toast).toContainText("Moved 2 sub-pages to Trash.");
    expect((await trashed(page)).sort()).toEqual(["kid", "kid2"]);
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator('.tiptap .prism-child-page[data-state=ready]')).toHaveCount(2);
    await expect.poll(async () => (await restored(page)).sort()).toEqual(["kid", "kid2"]);
    expect(await page.evaluate(() => (window as any).prismMediaVault.filter((n: any) => n.tags.includes("prism-trashed")).length)).toBe(0);
    const back = await html(page);
    expect(back.indexOf('data-page-id="kid"')).toBeGreaterThan(-1);
    expect(back.indexOf('data-page-id="kid"')).toBeLessThan(back.indexOf('data-page-id="kid2"'));
  });

  test("live page: one person deletes the row — the page is trashed once, and their undo restores it once", async ({ page }) => {
    await seedKids(page);
    await media(page, `${kidDoc}&live&livehost`);
    const a = page.getByRole("region", { name: "Client A" });
    const b = page.getByRole("region", { name: "Client B" });
    await expect(a.locator(".prism-child-page[data-state=ready]")).toHaveCount(1);
    await expect(b.locator(".prism-child-page[data-state=ready]")).toHaveCount(1);
    await page.waitForTimeout(650);
    await selectRow(page, "kid", 0);
    await page.keyboard.press("Backspace");
    await expect(a.locator(".prism-child-page")).toHaveCount(0);
    await expect(b.locator(".prism-child-page")).toHaveCount(0);
    await expect(page.locator(".page-toast")).toContainText("Moved “Trip plan” to Trash.");
    await settle(page);
    // B only SAW the row go (a collaborator's change): it trashed nothing.
    expect(await trashed(page)).toEqual(["kid"]);
    // A's own undo (it arrives through the shared document) brings row and page back — once.
    await page.locator(".tiptap").nth(0).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(a.locator(".prism-child-page[data-state=ready]")).toHaveCount(1);
    await expect(b.locator(".prism-child-page[data-state=ready]")).toHaveCount(1);
    await settle(page);
    expect(await restored(page)).toEqual(["kid"]);
    expect(await trashed(page)).toEqual(["kid"]);
  });
});

for (const size of [{ name: "phone", viewport: { width: 390, height: 844 }, phone: true }, { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false }]) {
  test.describe(`the app, ${size.name}`, () => {
    test.use(size.phone ? { viewport: size.viewport, hasTouch: true, isMobile: true } : { viewport: size.viewport });

    test("deleting a sub-page's row from its parent moves it to the Trash, with Undo", async ({ page }, info) => {
      await page.goto("/e2e-fixtures/notion-shell.html");
      const editor = page.locator(".tiptap[contenteditable=true]");
      await expect(editor).toBeVisible();
      await editor.locator("p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/page");
      await page.getByRole("option", { name: /^Page Add a sub-page/ }).click();
      const row = page.locator(".tiptap .prism-child-page[data-state=ready]");
      await expect(row).toHaveCount(1);
      const before = await html(page);
      const shell = (fn: string) => page.evaluate(`(() => { const s = window.prismShell; return ${fn}; })()`);
      const tags = () => shell(`s.note("created-1").tags`) as Promise<string[]>;
      const posts = (suffix: string) => shell(`s.writes.filter((w) => w.method === "POST" && w.path.endsWith(${JSON.stringify(suffix)})).length`) as Promise<number>;
      await page.waitForTimeout(650); // the history's own grouping window
      await selectRow(page, "created-1");
      await page.keyboard.press("Backspace");
      await expect(page.locator(".tiptap .prism-child-page")).toHaveCount(0);
      // No question: the page is in the Trash (tagged, still in the vault) and the toast offers Undo.
      const toast = page.locator(".page-toast");
      await expect(toast).toContainText("Moved “Untitled” to Trash.");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect.poll(tags).toContain("prism-trashed");
      expect(await posts("/created-1/trash")).toBe(1);
      expect(await shell(`s.writes.filter((w) => w.method === "DELETE").length`), "never a permanent delete").toBe(0);
      await page.screenshot({ path: info.outputPath(`subpage-trashed-${size.name}.png`) });
      // Undo brings it back: out of the Trash, row where it was.
      await toast.getByRole("button", { name: "Undo" }).click();
      await expect(row).toHaveCount(1);
      await expect.poll(tags).not.toContain("prism-trashed");
      expect(await posts("/trash/created-1/restore")).toBe(1);
      expect(await html(page)).toBe(before);
      await expect(toast).toContainText("Restored “Untitled”");
    });
  });
}
