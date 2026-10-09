import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { connect, startRealServer, type RealServer } from "./real-server";
import { openKeyboard as keyboard, selectWord } from "./editing-chrome-helpers";

/**
 * Before/after screenshots of the page/editor chrome on a phone (and one desktop frame each).
 * Not an assertion suite: `editing-chrome.spec.ts` holds the rules. Run alone (it changes the shared seed page) with
 * `CHROME_SHOTS=before|after` to write JPGs to `qa/screenshots/editing-chrome/<dir>/`; skipped otherwise.
 */
const dir = process.env.CHROME_SHOTS;
test.skip(!dir, "set CHROME_SHOTS=before|after to (re)write the screenshots");
test.describe.configure({ mode: "serial" });
const out = (name: string) => path.resolve(process.cwd(), "../../qa/screenshots/editing-chrome", dir ?? "after", `${name}.jpg`);
const shot = async (page: Page, name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: out(name), type: "jpeg", quality: 82 }); };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

let server: RealServer;
test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
test.afterAll(async () => server?.stop());

async function live(page: Page, who: "sam" | "eve" | "owner" | "gina", id = "plan") {
  await connect(page, page.context(), server, who);
  await page.goto(`/e2e-fixtures/collab-route.html?target=${id}`);
  await expect(page.locator(".tiptap").first()).toContainText("Alpha");
}

test("plain page", async ({ browser }) => {
  const ctx = await browser.newContext(PHONE); const page = await ctx.newPage();
  await page.goto("/e2e-fixtures/notion-shell.html");
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await expect(page.getByRole("button", { name: "2 backlinks" })).toBeVisible();
  await shot(page, "plain-390");
  await editor.locator("p").first().tap();
  await keyboard(page);
  await shot(page, "plain-390-keyboard");
  await selectWord(page, "workshop");
  await shot(page, "plain-390-keyboard-selection");
  await ctx.close();
  const narrow = await browser.newContext({ ...PHONE, viewport: { width: 320, height: 844 } }); const small = await narrow.newPage();
  await small.goto("/e2e-fixtures/notion-shell.html");
  await expect(small.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await shot(small, "plain-320");
  await narrow.close();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const wide = await desk.newPage();
  await wide.goto("/e2e-fixtures/notion-shell.html");
  await expect(wide.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await shot(wide, "plain-desktop");
  await desk.close();
});

test("live page", async ({ browser }) => {
  for (const [who, name] of [["owner", "live-editor"], ["sam", "live-suggest-only"], ["gina", "live-read-only"]] as const) {
    const ctx = await browser.newContext(PHONE); const page = await ctx.newPage();
    await live(page, who);
    await shot(page, `${name}-390`);
    if (who === "owner") {
      await page.locator(".tiptap p").first().tap();
      await keyboard(page);
      await shot(page, `${name}-390-keyboard`);
    }
    await selectWord(page, "gamma");
    await shot(page, `${name}-390-selection`);
    await ctx.close();
  }
  const narrow = await browser.newContext({ ...PHONE, viewport: { width: 320, height: 844 } }); const small = await narrow.newPage();
  await live(small, "owner");
  await shot(small, "live-editor-320");
  await narrow.close();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const wide = await desk.newPage();
  await live(wide, "owner");
  await shot(wide, "live-editor-desktop");
  await desk.close();
});

test("live page with pending suggestions and comments", async ({ browser }) => {
  // Sam (suggest-only) sends one suggestion and one page comment; the owner then opens the page.
  const samCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const sam = await samCtx.newPage();
  await live(sam, "sam");
  await selectWord(sam, "beta");
  await sam.getByRole("button", { name: "Suggest an edit to the selection" }).click();
  const composer = sam.getByRole("dialog", { name: "Suggest an edit" });
  await composer.getByLabel("Replacement text").fill("delta");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(sam.locator('[data-suggestion="insert"]')).toHaveText("delta");
  await sam.getByRole("button", { name: "Add comment" }).click(); // desktop width: the page discussion under the title
  await sam.getByLabel("Comment on this page").fill("Is this the final plan?");
  await sam.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(sam.getByText("Is this the final plan?")).toBeVisible();
  await samCtx.close();
  for (const [width, tag] of [[390, "390"], [320, "320"]] as const) {
    const ctx = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } }); const page = await ctx.newPage();
    await live(page, "owner");
    await expect(page.locator('[data-suggestion="insert"]')).toHaveText("delta");
    await shot(page, `live-review-${tag}`);
    if (width === 390) {
      await page.locator(".tiptap p").nth(1).tap();
      await keyboard(page);
      await selectWord(page, "Second");
      await shot(page, "live-review-390-keyboard-selection");
    }
    await ctx.close();
  }
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const wide = await desk.newPage();
  await live(wide, "owner");
  await expect(wide.locator('[data-suggestion="insert"]')).toHaveText("delta");
  await shot(wide, "live-review-desktop");
  await desk.close();
});
