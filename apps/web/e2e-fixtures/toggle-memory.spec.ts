import { test, expect, type Page } from "@playwright/test";

/**
 * NP-ED-08 — a toggle's open/closed state is remembered on THIS device, per page:
 * never in the document, never a transaction, never shared with a collaborator.
 * Plain editor (editor-blocks fixture), live editor pair (notion-media ?live) and the
 * real shell (notion-shell: sign-out clears it).
 */
const CONTENT =
  '<p>Intro</p>' +
  '<details data-type="toggle"><summary>Alpha</summary><p>First alpha body with a zebra.</p></details>' +
  '<details data-type="toggle"><summary>Beta</summary><p>Beta body.</p><details data-type="toggle"><summary>Inner</summary><p>Inner body with a <span data-type="mention" data-kind="date" data-date="2026-10-09" data-mention-uid="deep-anchor"></span> date.</p></details></details>' +
  '<details data-type="toggle"><summary>Alpha</summary><p>Second alpha body.</p></details>';
const plainUrl = (content = CONTENT) => `/e2e-fixtures/editor-blocks.html?content=${encodeURIComponent(content)}`;
const liveUrl = `/e2e-fixtures/notion-media.html?live&memory&content=${encodeURIComponent(CONTENT)}`;

/** Top-level toggles of one editor, in document order (Alpha, Beta, Alpha); Beta holds "Inner". */
const toggles = (page: Page, root = ".tiptap") => page.locator(`${root} > .prism-toggle`);
const states = (page: Page, root = ".tiptap") => page.locator(`${root} .prism-toggle`).evaluateAll((els) => els.map((el) => el.getAttribute("data-open")));
const arrow = (page: Page, index: number, root = ".tiptap") => toggles(page, root).nth(index).locator(":scope > .prism-toggle-arrow");
const stored = (page: Page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("prism:toggles:")).map((k) => [k, JSON.parse(localStorage.getItem(k)!)])) as Record<string, Array<[string, string[]]>>);
const html = (page: Page, index = 0) => page.evaluate((i) => (document.querySelectorAll(".tiptap")[i] as any).editor.getHTML() as string, index);

async function openPlain(page: Page, url = plainUrl()) {
  await page.goto(url);
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(toggles(page)).toHaveCount(3);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("plain editor: two closed toggles are still closed after a reload; nothing is written to the page", async ({ page }) => {
  await openPlain(page);
  expect(await states(page)).toEqual(["true", "true", "true", "true"]);
  const before = await html(page);
  await page.evaluate(() => {
    const log: number[] = [];
    (document.querySelector(".tiptap") as any).editor.on("transaction", ({ transaction }: any) => { if (transaction.docChanged) log.push(1); });
    (window as any).toggleTx = log;
  });
  await arrow(page, 0).click();
  await arrow(page, 1).click();
  expect(await states(page)).toEqual(["false", "false", "true", "true"]);
  await expect(page.getByText("First alpha body with a zebra.")).toBeHidden();
  await expect(page.getByText("Beta body.")).toBeHidden();
  await expect(page.getByText("Second alpha body.")).toBeVisible();
  // View state only: no transaction, no attribute on the content element, the same document, no save.
  expect(await page.evaluate(() => (window as any).toggleTx.length)).toBe(0);
  expect(await html(page)).toBe(before);
  expect(before).not.toContain("open");
  expect(await page.locator(".tiptap .prism-toggle-body").evaluateAll((els) => els.map((el) => el.getAttributeNames().filter((n) => n !== "class")))).toEqual([[], [], [], []]);
  // One entry for this page: two identity keys (summary hash + ordinal) — never the summary text.
  const memory = await stored(page);
  expect(Object.keys(memory)).toEqual(["prism:toggles:_"]);
  expect(memory["prism:toggles:_"]!.map(([id, keys]) => [id, keys.length])).toEqual([["blocks", 2]]);
  expect(JSON.stringify(memory)).not.toMatch(/Alpha|Beta/);
  for (const key of memory["prism:toggles:_"]![0]![1]) expect(key).toMatch(/^[0-9a-z]{1,8}\.\d+$/);

  await page.reload();
  await expect(toggles(page)).toHaveCount(3);
  await expect.poll(() => states(page)).toEqual(["false", "false", "true", "true"]);
  await expect(page.getByText("First alpha body with a zebra.")).toBeHidden();
  await expect(arrow(page, 0)).toHaveAttribute("aria-expanded", "false");
  await expect(arrow(page, 0)).toHaveAccessibleName("Expand toggle");
  // Restoring the memory is not an edit either: the page is never saved because of it.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).prismBlockWrites.length)).toBe(0);
  expect(await html(page)).toBe(before);

  // Opening one again is remembered too; the last open toggle leaves no entry behind.
  await arrow(page, 0).click();
  await page.reload();
  await expect(toggles(page)).toHaveCount(3);
  await expect.poll(() => states(page)).toEqual(["true", "false", "true", "true"]);
  await arrow(page, 1).click();
  expect(await stored(page)).toEqual({});
});

test("plain editor: toggles with the same summary are told apart, and a nested toggle keeps its own state", async ({ page }) => {
  await openPlain(page);
  // The SECOND "Alpha", and "Inner" inside Beta.
  await arrow(page, 2).click();
  await toggles(page).nth(1).locator(".prism-toggle .prism-toggle-arrow").click();
  expect(await states(page)).toEqual(["true", "true", "false", "false"]);
  await page.reload();
  await expect(toggles(page)).toHaveCount(3);
  await expect.poll(() => states(page)).toEqual(["true", "true", "false", "false"]);
  await expect(page.getByText("First alpha body with a zebra.")).toBeVisible();
  await expect(page.getByText("Second alpha body.")).toBeHidden();
  await expect(page.getByText("Beta body.")).toBeVisible();
  await expect(page.getByText("Inner body with a")).toBeHidden();
  // Closing the outer one and opening it again leaves the inner one as it was.
  await arrow(page, 1).click();
  await arrow(page, 1).click();
  expect(await states(page)).toEqual(["true", "true", "false", "false"]);
});

test("plain editor: renaming a closed toggle keeps it closed under its new name", async ({ page }) => {
  await openPlain(page);
  await arrow(page, 1).click();
  const first = (await stored(page))["prism:toggles:_"]![0]![1];
  await toggles(page).nth(1).locator(":scope > .prism-toggle-body > summary").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plans");
  await expect(toggles(page).nth(1).locator(":scope > .prism-toggle-body > summary")).toHaveText("Beta plans");
  await expect.poll(async () => (await stored(page))["prism:toggles:_"]?.[0]?.[1]).not.toEqual(first);
  const renamed = (await stored(page))["prism:toggles:_"]![0]![1];
  expect(renamed).toHaveLength(1);
  expect(await states(page)).toEqual(["true", "false", "true", "true"]);
  // The page as it is now stored, opened again: the renamed toggle is closed.
  const saved = await html(page);
  await openPlain(page, plainUrl(saved));
  await expect.poll(() => states(page)).toEqual(["true", "false", "true", "true"]);
});

test("find and a deep link open the closed toggles around their target, without remembering it", async ({ page }) => {
  await openPlain(page);
  await arrow(page, 0).click();
  await toggles(page).nth(1).locator(".prism-toggle .prism-toggle-arrow").click();
  await arrow(page, 1).click();
  expect(await states(page)).toEqual(["false", "false", "false", "true"]);
  const memory = await stored(page);

  // Find: the match is inside the closed first toggle.
  await page.locator(".tiptap").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in note" });
  await expect(find).toBeVisible();
  await find.fill("zebra");
  await find.press("Enter");
  await expect.poll(() => states(page)).toEqual(["true", "false", "false", "true"]);
  await expect(page.getByText("First alpha body with a zebra.")).toBeVisible();
  await expect(page.getByText("First alpha body with a zebra.")).toBeInViewport();
  await page.keyboard.press("Escape");

  // A notification anchor two toggles deep (Beta → Inner): both open, the chip is on screen.
  expect(await page.evaluate(() => (window as any).prismFocusAnchor('[data-mention-uid="deep-anchor"]'))).toBe(true);
  await expect.poll(() => states(page)).toEqual(["true", "true", "true", "true"]);
  await expect(page.locator('[data-mention-uid="deep-anchor"]')).toBeInViewport();

  // The reader went to something; they did not open the toggles. Next time the page is as they left it.
  expect(await stored(page)).toEqual(memory);
  await page.reload();
  await expect(toggles(page)).toHaveCount(3);
  await expect.poll(() => states(page)).toEqual(["false", "false", "false", "true"]);
});

test("a hostile or broken memory entry is ignored; storage that throws leaves toggles working", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prism:toggles:_", JSON.stringify([["blocks", ["__proto__", "x".repeat(5000), 7, null, "zz.0"]], "junk", ["blocks"], [7, ["a.0"]]]));
  });
  await openPlain(page);
  expect(await states(page)).toEqual(["true", "true", "true", "true"]);
  await arrow(page, 0).click();
  expect((await states(page))[0]).toBe("false");

  // No storage at all (private mode / blocked site data): still a working toggle, this session only.
  await page.addInitScript(() => {
    for (const name of ["getItem", "setItem", "removeItem"] as const) {
      const real = Storage.prototype[name] as (...args: string[]) => unknown;
      (Storage.prototype as any)[name] = function (this: Storage, ...args: string[]) {
        if (String(args[0]).startsWith("prism:toggles:")) throw new DOMException("denied", "SecurityError");
        return real.apply(this, args);
      };
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.reload();
  await expect(toggles(page)).toHaveCount(3);
  expect(await states(page)).toEqual(["true", "true", "true", "true"]);
  await arrow(page, 2).click();
  expect(await states(page)).toEqual(["true", "true", "true", "false"]);
  await arrow(page, 2).click();
  expect(await states(page)).toEqual(["true", "true", "true", "true"]);
  expect(errors).toEqual([]);
});

test("live editors: my closed toggles survive a reload, and a collaborator's toggling never changes mine", async ({ page }) => {
  await page.goto(liveUrl);
  const A = 'section[aria-label="Client A"] .tiptap';
  const B = 'section[aria-label="Client B"] .tiptap';
  await expect(toggles(page, A)).toHaveCount(3);
  await expect(toggles(page, B)).toHaveCount(3);
  // A closes Alpha and Beta; B sees them open and closes only the last one.
  await arrow(page, 0, A).click();
  await arrow(page, 1, A).click();
  expect(await states(page, A)).toEqual(["false", "false", "true", "true"]);
  expect(await states(page, B)).toEqual(["true", "true", "true", "true"]);
  await arrow(page, 2, B).click();
  expect(await states(page, A)).toEqual(["false", "false", "true", "true"]);
  expect(await states(page, B)).toEqual(["true", "true", "true", "false"]);
  // B opens and closes the toggle A closed, then types in its body: A's stays closed, and gets the text.
  await arrow(page, 0, B).click();
  await arrow(page, 0, B).click();
  await page.locator(`${B} > .prism-toggle`).nth(0).getByText("First alpha body with a zebra.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Added by Ben.");
  await expect.poll(() => html(page, 0)).toContain("zebra. Added by Ben.");
  expect(await states(page, A)).toEqual(["false", "false", "true", "true"]);
  await expect(page.locator(`${A} > .prism-toggle`).nth(0).getByText("Added by Ben.")).toBeHidden();
  // The shared document carries no open state: both clients hold the same HTML, without "open".
  expect(await html(page, 0)).toBe(await html(page, 1));
  expect(await html(page, 0)).not.toMatch(/\sopen[=\s>]/);
  // Each reader has their own entry (two devices in the app; two page ids in this fixture).
  const memory = (await stored(page))["prism:toggles:_"]!;
  expect(Object.fromEntries(memory.map(([id, keys]) => [id, keys.length]))).toEqual({ media: 2, "media-peer": 1 });

  await page.reload();
  await expect(toggles(page, A)).toHaveCount(3);
  await expect(toggles(page, B)).toHaveCount(3);
  await expect.poll(() => states(page, A)).toEqual(["false", "false", "true", "true"]);
  await expect.poll(() => states(page, B)).toEqual(["true", "true", "true", "false"]);
});

test("the real shell: the memory is kept per account + vault, and signing out clears it", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html?toggles");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("handbook", "Handbook", "document"));
  const top = page.locator("#workspace-document .tiptap > .prism-toggle");
  await expect(top).toHaveCount(2);
  await top.nth(0).locator(":scope > .prism-toggle-arrow").click();
  await top.nth(1).locator(".prism-toggle .prism-toggle-arrow").click();
  await expect(page.getByText("Book trains early.")).toBeHidden();
  const memory = await stored(page);
  const keys = Object.keys(memory);
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toBe("prism:toggles:_"); // the signed-in account + vault, not the anonymous scope
  expect(memory[keys[0]!]!.map(([id, k]) => [id, k.length])).toEqual([["handbook", 2]]);
  // Another device / a reload: the page reopens as this reader left it.
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("handbook", "Handbook", "document"));
  await expect(top).toHaveCount(2);
  await expect.poll(() => page.locator("#workspace-document .tiptap .prism-toggle").evaluateAll((els) => els.map((el) => el.getAttribute("data-open")))).toEqual(["false", "true", "false"]);
  // Sign out: device-local state of the account leaves the device.
  expect(await page.evaluate(() => (window as any).prismShellLogout())).toBe(true);
  expect(await stored(page)).toEqual({});
});
