import { test, expect, type Page } from "@playwright/test";

/** Wave 2E · NP-MB-06 edge swipe (synthetic touch events; the visible Back and
 *  Browse buttons stay the alternatives). */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function swipe(page: Page, fromX: number, toX: number, y = 420) {
  await page.evaluate(({ fromX, toX, y }) => {
    const target = document.elementFromPoint(fromX, y) ?? document.body;
    const touch = (x: number) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(fromX)], changedTouches: [touch(fromX)] }));
    for (let i = 1; i <= 6; i++) {
      const x = fromX + ((toX - fromX) * i) / 6;
      target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(x)], changedTouches: [touch(x)] }));
    }
    target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch(toX)] }));
  }, { fromX, toX, y });
}

test("edge swipe goes back, else opens the drawer; mid-screen swipes are left to the page", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await swipe(page, 120, 300);
  await expect(drawer).toHaveCount(0);
  await swipe(page, 6, 200);
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Field notes", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await swipe(page, 6, 220);
  await expect.poll(() => page.evaluate(() => { const s = (window as any).prismShellUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("workspace");
  await expect(drawer).toHaveCount(0);
});
