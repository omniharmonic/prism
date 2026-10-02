import { test, expect, type Page } from "@playwright/test";
const summary =
  "The team agreed to meet Tuesday. The agenda is still an open question.";
async function openSummary(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/messages.html?email&agent${query}`);
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Summary instructions" }),
  ).toBeEnabled();
}
async function generate(page: Page) {
  await page
    .getByRole("button", { name: "Generate summary", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved summary", exact: true }),
  ).toContainText(summary);
}
for (const width of [1440, 390, 320])
  test(`saved summary is explicit, read-only and copy-only at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSummary(page, "&email-visual&readonly");
    expect(
      await page.evaluate(() => (window as any).prismReplyAgent.sends),
    ).toEqual([]);
    await page
      .getByRole("textbox", { name: "Summary instructions" })
      .fill("Focus on decisions.");
    await generate(page);
    await expect(
      page.getByRole("button", { name: "Insert into reply" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Uses the saved conversation note.", { exact: false }),
    ).toBeVisible();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).copiedSummary = text;
          },
        },
      }),
    );
    await page
      .getByRole("button", { name: "Copy summary", exact: true })
      .click();
    await expect(
      page.getByText("Summary copied", { exact: true }),
    ).toBeVisible();
    const calls = await page.evaluate(() => ({
      creates: (window as any).prismReplyAgent.creates,
      sends: (window as any).prismReplyAgent.sends,
      copied: (window as any).copiedSummary,
      outbound: (window as any).prismMessagesFixture.attempts,
    }));
    expect(calls.creates).toHaveLength(1);
    expect(calls.creates[0]).toMatchObject({
      noteId: "email-fixture",
      permissionMode: "read-only",
      profile: "prism-ro",
    });
    expect(calls.sends).toHaveLength(1);
    expect(calls.sends[0].prompt).toContain(
      "Do not send any message, modify any note, or create tasks.",
    );
    expect(calls.copied).toBe(summary);
    expect(calls.outbound).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`agent-summary-${width}.png`),
      animations: "disabled",
    });
  });

test("reply and summary retain separate instructions, sessions, receipts and the human draft", async ({
  page,
}) => {
  await openSummary(page);
  await page
    .getByRole("textbox", { name: "Summary instructions" })
    .fill("Focus on decisions.");
  await page
    .getByRole("button", { name: "Close conversation summary", exact: true })
    .click();
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Summary instructions" }),
  ).toHaveValue("Focus on decisions.");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("My unsent reply.");
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Agent draft instructions" })
    .fill("Thank Morgan.");
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Summary instructions" }),
  ).toHaveValue("Focus on decisions.");
  await generate(page);
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Agent draft instructions" }),
  ).toHaveValue("Thank Morgan.");
  await page
    .getByRole("button", { name: "Generate draft", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("My unsent reply.");
  const calls = await page.evaluate(() => ({
    creates: (window as any).prismReplyAgent.creates,
    sends: (window as any).prismReplyAgent.sends,
  }));
  expect(calls.creates).toHaveLength(2);
  expect(calls.sends[0].sessionId).not.toBe(calls.sends[1].sessionId);
  expect(calls.sends[0].requestId).not.toBe(calls.sends[1].requestId);
  expect(calls.sends[0].prompt).not.toContain("My unsent reply.");
  expect(calls.sends[1].prompt).toContain(
    "My existing draft, for context only:\nMy unsent reply.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Saved summary", exact: true }),
  ).toContainText(summary);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.creates.length),
  ).toBe(0);
});

test("lost summary acknowledgements recover the same request", async ({
  page,
}) => {
  await page.goto(
    "/e2e-fixtures/messages.html?email&agent&lostcreate&lostturn",
  );
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry session", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Generate summary", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Summary instructions" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry generation", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved summary", exact: true }),
  ).toContainText(summary);
  const calls = await page.evaluate(() => ({
    creates: (window as any).prismReplyAgent.creates,
    sends: (window as any).prismReplyAgent.sends,
  }));
  expect(calls.creates).toHaveLength(2);
  expect(calls.creates[0].requestId).toBe(calls.creates[1].requestId);
  expect(calls.sends).toHaveLength(2);
  expect(calls.sends[0]).toEqual(calls.sends[1]);
});

test("running summary survives close and reply switching without another run or cancellation", async ({
  page,
}) => {
  await openSummary(page, "&pending");
  await page
    .getByRole("button", { name: "Generate summary", exact: true })
    .click();
  await expect(
    page.getByText("The agent is preparing your summary.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close conversation summary", exact: true })
    .click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Agent draft instructions" })
    .fill("Unsent instructions");
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByText("The agent is preparing your summary.", { exact: false }),
  ).toBeVisible();
  const counts = await page.evaluate(() => {
    const a = (window as any).prismReplyAgent;
    return {
      sends: a.sends.length,
      cancels: a.cancellations,
      streams: a.streams,
      unsubscribes: a.unsubscribes,
    };
  });
  expect(counts).toMatchObject({ sends: 1, cancels: 0 });
  expect(counts.streams - counts.unsubscribes).toBe(1);
});

test("fresh note and mode checks block summary generation and copying", async ({
  page,
}) => {
  await openSummary(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("fixture-agent-reply:")) continue;
      const d = JSON.parse(localStorage.getItem(key)!);
      d.session.permission_mode = "read-write";
      localStorage.setItem(key, JSON.stringify(d));
    }
  });
  await page
    .getByRole("button", { name: "Generate summary", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "note or permissions changed",
  );
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.sends.length),
  ).toBe(0);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("fixture-agent-reply:")) continue;
      const d = JSON.parse(localStorage.getItem(key)!);
      d.session.permission_mode = "read-only";
      localStorage.setItem(key, JSON.stringify(d));
    }
  });
  await generate(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("fixture-agent-reply:")) continue;
      const d = JSON.parse(localStorage.getItem(key)!);
      d.session.note_id = "another-note";
      localStorage.setItem(key, JSON.stringify(d));
    }
  });
  await page.getByRole("button", { name: "Copy summary", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Summary could not be copied",
  );
  await expect(page.getByText("Summary copied", { exact: true })).toHaveCount(
    0,
  );
});

test("clipboard failure remains visible and account switch hides old summary", async ({
  page,
}) => {
  await openSummary(page);
  await generate(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("Clipboard unavailable");
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Copy summary", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Clipboard unavailable");
  await page.evaluate(() => (window as any).prismMessagesFixture.switchActor());
  await expect(
    page.getByRole("region", { name: "Saved summary", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Summary instructions" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "Saved summary", exact: true }),
  ).toHaveCount(0);
});

test("message renderer exposes summary with no outbound client and no reply authorization", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/live-thread.html?agent&readonly");
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Conversation summary", exact: true }),
  ).toBeVisible();
  await generate(page);
  expect(
    await page.evaluate(() => (window as any).prismLiveThreadFixture.writes),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Close conversation summary", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeDisabled();
});
