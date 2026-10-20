import { test, expect } from "@playwright/test";
import { splitEmailQuote } from "../../../packages/core/src/lib/messages/emailQuote";

for (const [body, kind] of [
  [
    "My reply.\r\n\r\nOn Tuesday, Alex wrote:\r\n> Earlier context\r\n> More context\r\n",
    "quoted history",
  ],
  ["An introduction.\n\n> A quoted passage\n> Its next line", "quoted text"],
  ["A complete answer.\n\n-- \nMorgan\nResearch partner", "signature"],
  ["> This email only contains quoted text.\n> Keep it visible.", null],
  ["On Tuesday, Alex wrote:\n> This entire message is a quote.", null],
  ["A heading\n\n---\n\n**From:** ordinary prose\nNo reliable marker.", null],
  ["A code example:\n```text\n-- \nquoted code\n```", null],
] as const) {
  test(`quote display preserves every character: ${body.slice(0, 28)}`, () => {
    const result = splitEmailQuote(body);
    expect(result.kind).toBe(kind);
    expect(result.visible + result.folded).toBe(body);
    if (kind === null) expect(result.visible).toBe(body);
  });
}

for (const [width, dark] of [
  [1440, false],
  [390, false],
  [320, true],
] as const) {
  test(`email and agent retain separate readable drafts at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/e2e-fixtures/messages.html?email-visual&agent");
    if (dark)
      await page.evaluate(() =>
        document.documentElement.classList.remove("light"),
      );
    const quote = page.getByText("Show quoted history", { exact: true });
    await expect(quote).toBeVisible();
    await expect(
      page.getByText(/Let’s use the first half hour/),
    ).not.toBeVisible();
    await quote.click();
    await expect(page.getByText(/Let’s use the first half hour/)).toBeVisible();
    await quote.click();
    await expect(
      page.getByRole("region", { name: "Attachments listed in source" }),
    ).toContainText("Agenda.pdf, workshop notes.txt");
    await expect(
      page
        .getByRole("region", { name: "Attachments listed in source" })
        .getByRole("link"),
    ).toHaveCount(0);
    if (width < 840)
      await page.screenshot({
        path: info.outputPath(
          `email-reader-${width}-${dark ? "dark" : "light"}.png`,
        ),
      });
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("I can facilitate the opening discussion.");
    await page
      .getByRole("button", { name: "Draft with agent", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Agent draft instructions" })
      .fill("Help refine my reply without adding commitments.");
    await page
      .getByRole("button", { name: "Generate draft", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Agent draft preview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Agent reply draft" }),
    ).toHaveCount(0);
    if (width === 1440) {
      await expect(draft).toBeInViewport();
      await expect(
        page.getByRole("complementary", { name: "Agent reply draft" }),
      ).toBeInViewport();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width < 840)
      await page
        .getByRole("region", { name: "Agent draft preview" })
        .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(
        `email-agent-${width}-${dark ? "dark" : "light"}.png`,
      ),
      fullPage: true,
    });
    await page.setViewportSize({
      width: width === 1440 ? 390 : 1440,
      height: 1000,
    });
    await expect(draft).toHaveValue("I can facilitate the opening discussion.");
    await expect(
      page.getByRole("textbox", { name: "Agent draft instructions" }),
    ).toHaveValue("Help refine my reply without adding commitments.");
    await draft.focus();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("complementary", { name: "Agent reply draft" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close agent draft" }).click();
    await expect(
      page.getByRole("button", { name: "Draft with agent", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Draft with agent", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Agent draft preview" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).prismReplyAgent.creates.length),
    ).toBe(1);
    expect(
      await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
    ).toBe(0);
  });
}

test("existing message anchor survives delayed content height above a reader", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html");
  const thread = page.getByRole("region", { name: "Conversation messages" });
  await expect(thread.locator("article")).toHaveCount(30);
  await thread.evaluate((el) => {
    el.scrollTop = 900;
    el.dispatchEvent(new Event("scroll"));
  });
  const anchor = await thread.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const visible = [
      ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((node) => node.getBoundingClientRect().bottom > top)!;
    return {
      id: visible.dataset.messageId!,
      offset: visible.getBoundingClientRect().top - top,
    };
  });
  // Reproduces an asynchronously measured media/body height without a live URL.
  await thread
    .locator("[data-message-id]")
    .first()
    .evaluate(async (el) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          el.style.minHeight = "420px";
          resolve();
        }),
      );
    });
  await expect
    .poll(async () =>
      thread.evaluate((el, saved) => {
        const node = el.querySelector<HTMLElement>(
          `[data-message-id="${saved.id}"]`,
        )!;
        return Math.abs(
          node.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            saved.offset,
        );
      }, anchor),
    )
    .toBeLessThan(2);
});
