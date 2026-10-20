import { test, expect, type Page } from "@playwright/test";
const region = (page: Page) =>
  page.getByRole("region", { name: "Conversation messages" });
async function position(page: Page) {
  return region(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const first = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((n) => n.getBoundingClientRect().bottom > top);
    return {
      id: first?.dataset.messageId,
      offset: first ? first.getBoundingClientRect().top - top : 0,
    };
  });
}
async function scroll(page: Page, top = 1550) {
  await region(page).evaluate((el, top) => {
    el.scrollTop = top;
  }, top);
  await expect
    .poll(() => region(page).evaluate((el) => el.scrollTop))
    .toBe(top);
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  return position(page);
}
async function same(page: Page, anchor: Awaited<ReturnType<typeof position>>) {
  await expect
    .poll(async () => {
      const now = await position(page);
      return now.id === anchor.id && Math.abs(now.offset - anchor.offset) < 2;
    })
    .toBe(true);
}
/** Two frames: queued scroll events and resize observations have been delivered. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
async function bottom(page: Page) {
  await expect
    .poll(() =>
      region(page).evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThan(2);
}
for (const width of [1440, 390])
  test(`exact event and offset survive thread reopen and reload at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e-fixtures/thread-reading.html");
    await bottom(page);
    const anchor = await scroll(page);
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reopen thread", exact: true })
      .click();
    await same(page, anchor);
    await page.reload();
    await same(page, anchor);
    const stored = await page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) =>
        key.startsWith("prism:thread-reading:v1:"),
      ),
    );
    expect(JSON.stringify(stored)).not.toContain("Fictional reading message");
    expect(JSON.stringify(stored)).not.toContain("sender_name");
    const parsed = JSON.parse(stored[0][1]);
    expect(Object.keys(parsed.positions[0]).sort()).toEqual([
      "atBottom",
      "conversation",
      "eventId",
      "offset",
      "savedAt",
    ]);
    await page.screenshot({
      path: test.info().outputPath(`restored-thread-${width}.png`),
    });
  });
test("account, vault, room and source mode never restore one another's anchor", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  const anchor = await scroll(page);
  for (const [method, other, original] of [
    ["setActor", "morgan", "alex"],
    ["setVault", "secondary", "primary"],
    ["setRoom", "room-b", "room-a"],
    ["setMode", "live", "saved"],
  ]) {
    await page.evaluate(
      ([method, value]) => (window as any).prismReadingFixture[method](value),
      [method, other],
    );
    await bottom(page);
    await page.evaluate(
      ([method, value]) => (window as any).prismReadingFixture[method](value),
      [method, original],
    );
    await same(page, anchor);
  }
});
test("missing saved event stays explicit until manually loaded, without automatic history fetch", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  const anchor = await scroll(page, 1000);
  await page.goto("/e2e-fixtures/thread-reading.html?window");
  await expect(page.getByRole("status")).toContainText(
    "not in this loaded window",
  );
  await expect(region(page).locator('[data-message-id="event-0"]')).toHaveCount(
    0,
  );
  await page
    .getByRole("status")
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "not in this loaded window",
  );
  await page
    .getByRole("status")
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await same(page, anchor);
  await expect(page.getByRole("status")).toHaveCount(0);
});
test("deliberate scrolling or latest abandons a missing restoration", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  await scroll(page, 1000);
  await page.goto("/e2e-fixtures/thread-reading.html?window");
  await expect(page.getByRole("status")).toContainText(
    "not in this loaded window",
  );
  const replacement = await scroll(page, 650);
  await expect(page.getByRole("status")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .evaluate((el) => (el as HTMLButtonElement).click());
  await same(page, replacement);
  // The thread saves its position on the next frame; write the fixture's value after it.
  await settled(page);
  await page.evaluate(() => {
    const f = (window as any).prismReadingFixture;
    f.save(f.identity, { eventId: "missing", offset: 0, atBottom: false });
  });
  await page.reload();
  await expect(page.getByRole("status")).toBeVisible();
  await page
    .getByRole("button", { name: "jump to latest", exact: true })
    .click();
  await bottom(page);
  await expect(page.getByRole("status")).toHaveCount(0);
});
test("delayed height and composer resizing preserve reading anchor and latest separately", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  const anchor = await scroll(page);
  await page.evaluate(() => (window as any).prismReadingFixture.expand());
  await same(page, anchor);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Long draft\n".repeat(15));
  await same(page, anchor);
  await page
    .getByRole("button", { name: "Receive message", exact: true })
    .click();
  await same(page, anchor);
  await page
    .getByRole("button", { name: "New messages ↓", exact: true })
    .click();
  await bottom(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Short draft");
  await bottom(page);
  // The thread grew, so the browser clamped its scrollTop and queued a scroll event.
  // No person shrinks and regrows a draft inside one frame; let that event arrive.
  await settled(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Long draft\n".repeat(15));
  await bottom(page);
});
test("typing in a tall draft never moves the thread", async ({ page }) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Long draft\n".repeat(15));
  await bottom(page);
  await settled(page);
  // Measuring the draft must not resize the thread, even for one layout.
  const moves = await region(page).evaluate((el) => {
    const seen: number[] = [];
    el.addEventListener("scroll", () => seen.push(el.scrollTop));
    (window as any).prismThreadScrolls = seen;
    return seen.length;
  });
  expect(moves).toBe(0);
  await box.pressSequentially("more");
  await settled(page);
  expect(await page.evaluate(() => (window as any).prismThreadScrolls)).toEqual(
    [],
  );
  await bottom(page);
  // Near the end but not following it: the reading anchor stays put too.
  await region(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 90;
  });
  await settled(page);
  const anchor = await position(page);
  await box.pressSequentially("more");
  await settled(page);
  expect(await position(page)).toEqual(anchor);
});
for (const failure of ["corrupt", "denied"])
  test(`${failure} storage never breaks reading or scrolling`, async ({
    page,
  }) => {
    if (failure === "denied")
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key.startsWith("prism:thread-reading:v1:"))
            throw new DOMException("Denied", "SecurityError");
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("prism:thread-reading:v1:"))
            throw new DOMException("Denied", "SecurityError");
          return set.call(this, key, value);
        };
      });
    await page.goto("/e2e-fixtures/thread-reading.html");
    await bottom(page);
    if (failure === "corrupt") {
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("prism:thread-reading:v1:"))
            localStorage.setItem(key, "{invalid");
      });
      await page.reload();
      await bottom(page);
    }
    const anchor = await scroll(page);
    await page
      .getByRole("button", { name: "Receive message", exact: true })
      .click();
    await same(page, anchor);
  });
test("storage bounds conversation history and expires old positions", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/thread-reading.html");
  await bottom(page);
  const result = await page.evaluate(() => {
    const f = (window as any).prismReadingFixture;
    for (let i = 0; i < 110; i++)
      f.save(
        { ...f.identity, conversation: `test-${i}` },
        { eventId: `event-${i}`, offset: -10, atBottom: false },
      );
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("prism:thread-reading:v1:"),
    )!;
    const data = JSON.parse(localStorage.getItem(key)!);
    const count = data.positions.length;
    data.positions = data.positions.map((e: any) => ({
      ...e,
      savedAt: Date.now() - 31 * 86400000,
    }));
    localStorage.setItem(key, JSON.stringify(data));
    return {
      count,
      expired: f.load({ ...f.identity, conversation: "test-109" }),
    };
  });
  expect(result).toEqual({ count: 100, expired: null });
});

test("actual renderer binds actor and vault scope and restores its saved timeline", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/live-thread.html?reading");
  const anchor = await scroll(page, 1600);
  await page.reload();
  await same(page, anchor);
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) =>
      k.startsWith("prism:thread-reading:v1:"),
    ),
  );
  expect(keys).toHaveLength(1);
  expect(keys[0]).toContain("fixture-actor");
  expect(keys[0]).toContain("fixture-owner");
  await page
    .getByRole("button", { name: "View latest messages", exact: true })
    .click();
  await bottom(page);
  await page
    .getByRole("button", { name: "View saved history", exact: true })
    .click();
  await same(page, anchor);
});
