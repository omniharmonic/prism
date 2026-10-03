import { test, expect } from "@playwright/test";

/**
 * Wave 3 gaps #1: which editor a suggest-level person gets when they open a
 * shared document from the sidebar inside the workspace.
 *   plain "can suggest" share       → the LIVE suggest-only editor (never a local draft)
 *   suggest from a governance role  → the propose-for-review draft
 *   create without suggest          → the propose-for-review draft (unchanged)
 * The live editor itself (read-only socket + command endpoint) is proven against
 * the real server in suggest-only.spec.ts.
 */
const live = "[data-testid=live-collab-doc]";

test("a plain suggest share opens the live suggest editor from the sidebar", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?as=suggest");
  await expect(page.locator(live)).toHaveAttribute("data-note", "workspace");
  await expect(page.getByText("Submit for review")).toHaveCount(0);
  // No local draft editor is mounted: nothing the person types can become a raw write.
  await expect(page.locator(".tiptap[contenteditable=true]")).toHaveCount(0);
  // Opening another shared page (what a tree row click does) routes the same way.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.locator(live)).toHaveAttribute("data-note", "field-notes");
  const writes = await page.evaluate(() => (window as any).prismShell.writes.filter((w: { method: string }) => w.method === "PATCH"));
  expect(writes).toEqual([]);
});

test("a governance reviewer role keeps the propose-for-review draft", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?as=governed");
  await expect(page.getByRole("button", { name: /Submit for review/ })).toBeVisible();
  await expect(page.locator(live)).toHaveCount(0);
});

test("create-without-suggest still proposes", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?as=creator");
  await expect(page.getByRole("button", { name: /Submit for review/ })).toBeVisible();
  await expect(page.locator(live)).toHaveCount(0);
});
