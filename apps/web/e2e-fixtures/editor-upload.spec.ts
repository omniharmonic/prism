import { test, expect, type Page } from "@playwright/test";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;
// 1×1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
const uploads = (page: Page) => page.evaluate(() => (window as any).prismBlockUploads as Array<{ noteId: string; name: string; type: string }>);

/** Dispatch a paste or drop of one file onto the editor. */
async function deliver(page: Page, kind: "paste" | "drop", name: string, type: string, at?: string) {
  await page.evaluate(async ({ kind, name, type, png, at }) => {
    const bytes = type === "image/png" ? Uint8Array.from(atob(png), (c) => c.charCodeAt(0)) : new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    const target = document.querySelector(".tiptap") as HTMLElement;
    if (kind === "paste") {
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } else {
      const el = [...target.querySelectorAll("p, h2")].find((n) => n.textContent === at) as HTMLElement;
      const r = el.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: r.right - 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    }
  }, { kind, name, type, png: PNG, at });
}

async function caretAfter(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await page.keyboard.press("End");
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.state.selection.$from.parent.textContent)).toBe(text);
}

test("pasting an image uploads it through the vault client and embeds the returned URL", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?upload");
  await caretAfter(page, "Bravo paragraph");
  await deliver(page, "paste", "chart.png", "image/png");
  await expect.poll(() => uploads(page)).toEqual([expect.objectContaining({ noteId: "blocks", name: "chart.png", type: "image/png" })]);
  await expect(page.locator('.tiptap img[src="/e2e-fixtures/fixture-image.svg?u=1"]')).toBeVisible();
  expect(await html(page)).toContain('<img src="/e2e-fixtures/fixture-image.svg?u=1" alt="chart">');
  expect(await html(page)).not.toContain("data:image");
  await expect.poll(() => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? ""), { timeout: 6000 }).toContain("fixture-image.svg?u=1");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/image-paste-1440.png` });
});

test("dropping an image inserts it where it was dropped", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?upload");
  await caretAfter(page, "Foxtrot closing");
  await deliver(page, "drop", "photo.png", "image/png", "Alpha");
  await expect.poll(() => uploads(page)).toHaveLength(1);
  await expect.poll(async () => (await html(page)).indexOf("<img")).toBeLessThan((await html(page)).indexOf("Bravo paragraph"));
});

test("unsupported files and failed uploads insert nothing and say why", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?upload");
  await caretAfter(page, "Bravo paragraph");
  await deliver(page, "paste", "vector.svg", "image/svg+xml");
  await expect(page.getByRole("alert").filter({ hasText: "Only PNG, JPEG, GIF, WebP and AVIF" })).toBeVisible();
  expect(await uploads(page)).toEqual([]);
  await page.evaluate(() => { (window as any).prismBlockControls.failUpload = true; });
  await deliver(page, "paste", "chart.png", "image/png");
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't upload chart.png. Nothing was added." })).toBeVisible();
  expect(await html(page)).not.toContain("<img");
});

test("the slash Image entry opens the file picker when uploads exist and keeps the URL path", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?upload");
  await caretAfter(page, "Foxtrot closing");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await expect(page.getByRole("option", { name: /^Image from URL/ })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
  await expect.poll(() => uploads(page)).toEqual([expect.objectContaining({ name: "picked.png" })]);
  await expect(page.locator(".tiptap img")).toHaveCount(1);
  page.once("dialog", (d) => d.accept("https://images.example.test/by-url.png"));
  await page.keyboard.type("/image");
  await page.getByRole("option", { name: /^Image from URL/ }).click();
  expect(await html(page)).toContain('src="https://images.example.test/by-url.png"');
});

test("without an uploader the feature is hidden: no upload on paste, slash Image asks for a URL", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html");
  await caretAfter(page, "Bravo paragraph");
  await deliver(page, "paste", "chart.png", "image/png");
  await page.waitForTimeout(150);
  expect(await html(page)).not.toContain("<img");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await expect(page.getByRole("option", { name: /^Image/ })).toHaveCount(1);
  page.once("dialog", (d) => { expect(d.message()).toBe("Image URL"); void d.accept("javascript:alert(1)"); });
  await page.keyboard.press("Enter");
  expect(await html(page)).not.toContain("javascript");
});

test("an upload that finishes after the document became read-only inserts nothing", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?upload");
  await caretAfter(page, "Bravo paragraph");
  await page.evaluate(() => (window as any).prismHoldUploads());
  await deliver(page, "paste", "late.png", "image/png");
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.setEditable(false));
  await page.evaluate(() => (window as any).prismBlockControls.release());
  await expect(page.getByRole("alert").filter({ hasText: "late.png was uploaded but not added" })).toBeVisible();
  expect(await html(page)).not.toContain("<img");
});
