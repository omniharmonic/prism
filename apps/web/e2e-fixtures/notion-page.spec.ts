import { test, expect, type Page } from "@playwright/test";

/** Wave 2B page cover (NP-PG-02). */
const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const meta = (page: Page) => page.evaluate(() => (window as any).prismMediaMeta as Array<Record<string, unknown>>);

test("cover add, reposition, remove", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-media.html");
  await page.locator(".document-page-header").hover();
  await page.getByRole("button", { name: "Add cover" }).click();
  const cover = page.locator(".document-cover");
  await expect(cover).toBeVisible();
  await expect.poll(async () => String((await meta(page)).at(-1)?.cover ?? "")).toMatch(/^gradient:/);
  await expect(page.getByRole("button", { name: "Add cover" })).toHaveCount(0);
  // Change → Gallery preset.
  await cover.hover();
  await page.getByRole("button", { name: "Change cover" }).click();
  const picker = page.getByRole("dialog", { name: "Page cover" });
  await picker.getByRole("listitem", { name: "Lagoon gradient" }).click();
  await expect.poll(async () => (await meta(page)).at(-1)).toEqual({ cover: "gradient:lagoon", coverY: 50 });
  // Change → Upload.
  await cover.hover();
  await page.getByRole("button", { name: "Change cover" }).click();
  await picker.getByRole("tab", { name: "Upload" }).click();
  await picker.locator('input[type="file"]').setInputFiles("e2e-fixtures/media/cover.png");
  await expect(cover.locator("img")).toHaveAttribute("src", "/e2e-fixtures/media/cover.png?u=1");
  expect((await page.evaluate(() => (window as any).prismMediaUploads)).at(-1)).toMatchObject({ name: "cover.png", kind: "image" });
  // Reposition by drag, then Save.
  await cover.hover();
  await page.getByRole("button", { name: "Reposition" }).click();
  await expect(cover).toHaveAttribute("data-repositioning", "true");
  const b = (await cover.boundingBox())!;
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2 + b.height * 0.3, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save position" }).click();
  const saved = (await meta(page)).at(-1)!;
  expect(saved.cover).toBe("/e2e-fixtures/media/cover.png?u=1");
  expect(Number(saved.coverY)).toBeLessThan(35);
  await expect(cover.locator("img")).toHaveCSS("object-position", new RegExp(`50% ${saved.coverY}%`));
  // Keyboard reposition is available too (↑/↓ then Enter).
  await cover.hover();
  await page.getByRole("button", { name: "Reposition" }).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  expect(Number((await meta(page)).at(-1)!.coverY)).toBe(Number(saved.coverY) + 5);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cover-desktop.png` });
  // Link tab refuses non-https.
  await cover.hover();
  await page.getByRole("button", { name: "Change cover" }).click();
  await picker.getByRole("tab", { name: "Link" }).click();
  await picker.getByRole("textbox", { name: "Image link" }).fill("javascript:alert(1)");
  await picker.getByRole("button", { name: "Use link" }).click();
  await expect(picker.getByRole("alert")).toHaveText("Paste an https:// image link.");
  await page.keyboard.press("Escape");
  // Remove.
  await cover.hover();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(cover).toHaveCount(0);
  expect((await meta(page)).at(-1)).toEqual({ cover: null, coverY: null });
});

test("cover renders cropped on phone and in dark mode; read-only has no controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/notion-media.html?dark&cover=" + encodeURIComponent("/e2e-fixtures/media/cover.png"));
  const cover = page.locator(".document-cover");
  await expect(cover.locator("img")).toBeVisible();
  const box = (await cover.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(388); // edge to edge
  expect(box.height).toBe(132);
  await expect(cover.locator("img")).toHaveCSS("object-fit", "cover");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "Change cover" })).toBeVisible(); // touch: controls always shown
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cover-phone-dark.png` });
  await page.goto("/e2e-fixtures/notion-media.html?readonly&cover=gradient:spectrum");
  await expect(page.locator(".document-cover")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change cover" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add cover" })).toHaveCount(0);
});
