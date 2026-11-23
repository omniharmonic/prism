import { test, expect, type Page } from "@playwright/test";

/**
 * The properties under a page title on a phone, and the "Tags" row.
 *  - Phone (≤ 767 px): one property per row, name on the left and value on the right. The old layout
 *    was two columns of name-over-value on one line each: a value wider than half the screen ran into
 *    the next column or was cut off.
 *  - "Tags" appears once. A page's tags are the note's own `tags`; an imported page that also keeps a
 *    frontmatter `tags:` list in metadata showed that as a second, free "Tags" property (at any width).
 * Fixture: `?long-props` gives the page a sentence, a URL and four labels; `?frontmatter-tags` the metadata key.
 */
const URL = "/e2e-fixtures/databases.html?open=page&long-props&frontmatter-tags";
const bar = (page: Page) => page.getByRole("group", { name: "Page properties" });

/** Every property row of the bar: where its name and its value are, and whether anything is cut off. */
const measure = (page: Page) => bar(page).evaluate((el) => {
  const box = (n: Element) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const rows = Array.from(el.querySelectorAll(":scope > .db-prop:not(.db-prop-trailing)")).map((row) => {
    const label = row.querySelector(":scope > .db-prop-label")!;
    const value = row.querySelector(":scope > :not(.db-prop-label)")!;
    // Text that sticks out of the row sideways (a one-line value wider than its column).
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const r = row.getBoundingClientRect();
    const sticksOut: string[] = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(t);
      for (const rect of Array.from(range.getClientRects())) if (rect.left < r.left - 9 || rect.right > r.right + 1) { sticksOut.push(t.textContent!.trim()); break; }
    }
    return { name: label.textContent, row: box(row), label: box(label), value: box(value), sticksOut };
  });
  return { bar: box(el), display: getComputedStyle(el).display, rows, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [390, 320]) test(`one property per row, nothing cut off or overlapping · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(URL);
    await expect(bar(page).getByRole("button", { name: /^Owner: Alexandria/ })).toBeVisible();
    const m = await measure(page);
    expect(m.rows.map((r) => r.name)).toEqual(["Status", "Priority", "Link", "Labels", "Owner", "Tags"]);
    expect(m.scroll).toBeLessThanOrEqual(m.viewport);
    for (const [i, r] of m.rows.entries()) {
      expect(r.sticksOut, `${r.name}: text outside its row`).toEqual([]);
      expect(r.label.right, `${r.name}: the name is left of the value`).toBeLessThanOrEqual(r.value.left + 9); // an editable value's hover box starts 8 px early
      expect(r.row.left, `${r.name}: rows share the left edge`).toBeCloseTo(m.bar.left, 0);
      expect(r.row.right, `${r.name}: inside the bar`).toBeLessThanOrEqual(m.bar.right + 1);
      expect(r.row.bottom - r.row.top, `${r.name}: a touch-height row`).toBeGreaterThanOrEqual(44);
      if (i) expect(r.row.top, `${r.name}: below ${m.rows[i - 1]!.name}`).toBeGreaterThanOrEqual(m.rows[i - 1]!.row.bottom - 0.5);
    }
    // The whole value is there: the sentence wraps instead of running off.
    await expect(bar(page).getByText("Alexandria Chen-Montgomery and the platform team", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`phone-properties-${width}.png`) });
  });

  // Configuration stays in one disclosure; tag spacing and 44px removal targets remain intact.
  for (const width of [390, 320]) test(`tags share a line where they fit; property configuration stays in one disclosure · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(URL);
    const props = bar(page);
    await expect(props.getByRole("button", { name: "Add property" })).toHaveCount(0);
    await expect(props.locator(".db-prop-actions")).toHaveCount(1);
    const middle = async (locator: ReturnType<Page["locator"]>) => { const b = (await locator.boundingBox())!; return b.y + b.height / 2; };
    const more = props.locator(".db-properties-menu > summary");
    const right = (await more.boundingBox())!;
    expect(right.height).toBeGreaterThanOrEqual(44);
    expect(right.x + right.width, '"Properties" is inside the bar').toBeLessThanOrEqual(width);
    if (width === 390) {
      const row = props.locator(".db-prop-tags");
      expect(Math.abs((await middle(row.getByRole("button", { name: "task", exact: true }))) - (await middle(row.getByRole("button", { name: "research", exact: true })))), "two tags share a line").toBeLessThanOrEqual(2);
    }
    // Every "×" keeps a 44 px touch box and no tag's "×" reaches into the next tag's name.
    const tags = await props.locator(".db-prop-tags .db-tag").evaluateAll((els) => els.map((el) => { const n = el.querySelector(".db-tag-name")!.getBoundingClientRect(); const x = el.querySelector(".db-opt-remove")!.getBoundingClientRect(); return { name: { left: n.left, right: n.right, top: n.top, bottom: n.bottom }, remove: { left: x.left, right: x.right, top: x.top, bottom: x.bottom, w: x.width, h: x.height } }; }));
    for (const [i, tag] of tags.entries()) {
      expect(Math.min(tag.remove.w, tag.remove.h)).toBeGreaterThanOrEqual(44);
      const next = tags[i + 1];
      if (next && Math.abs(next.name.top - tag.name.top) < 2) expect(tag.remove.right, "the × ends before the next tag").toBeLessThanOrEqual(next.name.left + 0.5);
    }
    // Opening "Properties" gives it a full row: nothing is squeezed into the right-hand column.
    await more.click();
    await expect(props.getByRole("button", { name:"Add property" })).toBeVisible();
    const content = (await props.locator(".db-properties-menu-content").boundingBox())!;
    expect(content.width).toBeGreaterThan(width * 0.6);
    expect(content.x + content.width).toBeLessThanOrEqual(width);
  });

  test("a value is still edited from its row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL);
    await bar(page).getByRole("button", { name: "Status: In progress" }).click();
    await page.getByRole("dialog", { name: "Choose Status" }).getByRole("option", { name: "Done" }).click();
    await expect(bar(page).getByRole("button", { name: "Status: Done" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).dbFixture.writes)).toEqual([{ id: "page", set: { status: "done" }, expect: { status: "in-progress" } }]);
  });
});

for (const [name, size, touch] of [["phone", { width: 390, height: 844 }, true], ["desktop", { width: 1440, height: 900 }, false]] as const) {
  test.describe(`Tags · ${name}`, () => {
    test.use({ hasTouch: touch, isMobile: touch });
    test("Tags appears once on a page whose metadata also has a `tags` list", async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(URL);
      const props = bar(page);
      await expect(props.getByRole("button", { name: "Status: In progress" })).toBeVisible();
      await expect(props.locator(".db-prop-label", { hasText: /^Tags$/ })).toHaveCount(1);
      // The one that stays is the note's own tags: its chips and "Add tag".
      const row = props.locator(".db-prop-tags");
      await expect(row.getByRole("button", { name: "task", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "research", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Add tag" })).toBeVisible();
      await expect(props.getByRole("button", { name: /^Tags:/ })).toHaveCount(0);
      // The metadata key itself is left alone.
      expect(await page.evaluate(() => (window as any).dbFixture.notes().find((n: any) => n.id === "page").metadata.tags)).toEqual(["research"]);
      expect(await page.evaluate(() => (window as any).dbFixture.writes)).toEqual([]);
    });
  });
}

test("desktop: the bar is unchanged — names over values, side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(URL);
  await expect(bar(page).getByRole("button", { name: /^Owner: Alexandria/ })).toBeVisible();
  const m = await measure(page);
  expect(m.display).toBe("flex");
  const [status, priority] = m.rows;
  expect(status!.label.bottom).toBeLessThanOrEqual(status!.value.top + 0.5); // the name is above its value
  expect(priority!.row.left).toBeGreaterThan(status!.row.right); // Priority sits beside Status
  expect(Math.abs(priority!.row.top - status!.row.top)).toBeLessThan(1);
  expect(status!.row.bottom - status!.row.top).toBeLessThan(70);
});
