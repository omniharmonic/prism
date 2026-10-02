import { test, expect } from "@playwright/test";
import { threadStatus } from "../../../packages/core/src/lib/messages/triage";

test("each tag combination has one consistent visible classification", () => {
  expect(threadStatus(["urgent", "handled"])).toBe("handled");
  expect(threadStatus(["low", "triaged"])).toBe("low");
  expect(threadStatus(["triaged"])).toBe("triaged");
  expect(threadStatus(["social"])).toBe("social");
  expect(threadStatus([])).toBe("unclassified");
});

test("Inbox counts unique conversations, keeps reviewed items visible and fits a phone", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/inbox.html");
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await expect(
    page.getByText("4 conversations", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Urgent/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Handled/ }).click();
  await expect(
    page.getByRole("button", { name: /Direct discussion/ }),
  ).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("reviewed");
  await expect(
    page.getByRole("button", { name: /Reviewed discussion/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Direct discussion/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("inbox-mobile.png"),
  });
});

test("People compose requires an explicit conversation and never uses a platform alias as recipient", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/inbox.html");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("button", { name: /Morgan/ }).click();
  await expect(page.getByText("2 threads", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Message destination" })
    .selectOption("group");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Only the selected group");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Message destination" }),
  ).toHaveCount(0);
  const sends = await page.evaluate(
    () => (window as any).prismInboxFixture.sends,
  );
  expect(sends).toHaveLength(1);
  expect(sends[0].room).toBe("!group:example.test");
  expect(sends[0].key).toBeTruthy();
});

test("People compose remains unavailable when the server cannot send", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/inbox.html?unavailable");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("button", { name: /Morgan/ }).click();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Messaging is unavailable on this connection."),
  ).toBeVisible();
});

test("a failed Inbox read offers recovery instead of claiming the list is complete", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/inbox.html?failed");
  await expect(page.getByRole("alert")).toContainText("couldn't load");
  await page.evaluate(() => {
    (window as any).prismInboxFixture.denyThreads = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("4 conversations", { exact: true }),
  ).toBeVisible();
});

test("a capped Inbox discloses missing history and offers whole-vault search", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/inbox.html?limited");
  await expect(
    page.getByText("Showing 500 conversations", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Older conversations may be outside",
  );
  await expect(
    page.getByRole("textbox", { name: "Search inbox" }),
  ).toHaveAttribute("placeholder", "Search loaded conversations…");
  await page
    .getByRole("button", { name: "Search all notes", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as any).prismInboxUI.getState().commandBarOpen,
    ),
  ).toBe(true);
});

test("desktop master/detail opens authorized conversations and keeps normal page navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/e2e-fixtures/inbox.html?visual");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  await page.getByRole("button", { name: /Workshop planning/ }).click();
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Messages", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Messages from You" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Messages from Mira Chen" }),
  ).toBeVisible();
  await expect(page.locator(".prism-messages-workspace")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("messages-desktop-light.png"),
  });
  await page.evaluate(() => document.documentElement.classList.remove("light"));
  await expect(page.locator(".prism-messages-workspace")).toHaveCSS(
    "background-color",
    "rgb(25, 26, 30)",
  );
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("messages-desktop-dark.png"),
  });
  await page.getByRole("button", { name: "Open as page", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).prismInboxUI
        .getState()
        .openTabs.some((tab: any) => tab.noteId === "group"),
    ),
  ).toBe(true);
});

for (const width of [390, 320])
  test(`phone ${width} retains list filters and scoped drafts when going back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/e2e-fixtures/inbox.html?visual");
    await page.evaluate(() => document.documentElement.classList.add("light"));
    await page.getByRole("textbox", { name: "Search inbox" }).fill("Workshop");
    await page.getByRole("button", { name: /Workshop planning/ }).click();
    await expect(
      page.getByRole("heading", { name: "Messages", exact: true }),
    ).not.toBeVisible();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Keep my reply while I check the list.");
    await page.getByRole("button", { name: "Back to messages" }).click();
    await expect(
      page.getByRole("textbox", { name: "Search inbox" }),
    ).toHaveValue("Workshop");
    await page.getByRole("button", { name: /Workshop planning/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Keep my reply while I check the list.");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`messages-${width}-light.png`),
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove("light"),
    );
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`messages-${width}-dark.png`),
    });
    await page.evaluate(() => (window as any).prismInboxFixture.switchScope());
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Messages", exact: true }),
    ).toBeVisible();
  });

test("failed detail reads show recovery without losing the filtered conversation list", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/inbox.html?visual");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  await page.evaluate(() => {
    (window as any).prismInboxFixture.denyDetail = true;
  });
  await page.getByRole("button", { name: /Workshop planning/ }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't be opened");
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).prismInboxFixture.denyDetail = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toBeVisible();
});

test("keyboard opening and long titles stay usable at 320px; back restores list scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/e2e-fixtures/inbox.html?visual&long");
  const row = page.getByRole("button", { name: /Workshop planning/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Back to messages" }).click();
  await expect(
    page.getByRole("heading", { name: "Messages", exact: true }),
  ).toBeVisible();
  await page.goto("/e2e-fixtures/inbox.html?limited");
  await page.getByRole("button", { name: "Platforms", exact: true }).click();
  const older = page.getByRole("button", { name: /^Older 30 / });
  await older.scrollIntoViewIfNeeded();
  const list = page.locator(".prism-messages-list > .overflow-auto");
  const top = await list.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await older.click();
  await page.getByRole("button", { name: "Back to messages" }).click();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(
    page.getByRole("button", { name: "Platforms", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
