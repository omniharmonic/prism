import { test, expect } from "@playwright/test";
const response =
  "Thanks, Morgan. Tuesday afternoon works well. I’ll send the agenda beforehand.";
async function openReply(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/e2e-fixtures/messages.html?email&agent${query}`);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Draft with agent", exact: true }),
  ).toBeVisible();
}
async function generate(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Agent draft instructions" })
    .fill("Thank Morgan and confirm Tuesday afternoon.");
  await page
    .getByRole("button", { name: "Generate draft", exact: true })
    .click();
}
for (const width of [1440, 390, 320])
  test(`agent prepares a read-only reply with explicit insertion at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openReply(page);
    await generate(page);
    await expect(
      page.getByRole("region", { name: "Agent draft preview" }),
    ).toContainText(response);
    const calls = await page.evaluate(() => {
      const f = (window as any).prismReplyAgent;
      return {
        creates: f.creates,
        sends: f.sends,
        outbound: (window as any).prismMessagesFixture.attempts,
      };
    });
    expect(calls.creates).toHaveLength(1);
    expect(calls.creates[0]).toMatchObject({
      noteId: "email-fixture",
      permissionMode: "read-only",
      profile: "prism-ro",
    });
    expect(calls.sends).toHaveLength(1);
    expect(calls.outbound).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`agent-reply-${width}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Insert into reply", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(response);
    expect(
      await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
    ).toBe(0);
  });

test("replacement is deliberate, append preserves existing text, and close/reload keeps the session", async ({
  page,
}) => {
  await openReply(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("My original thought.");
  await generate(page);
  await page
    .getByRole("button", { name: "Replace existing reply…", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Confirm reply replacement" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep existing reply", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close agent draft", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("My original thought.");
  await page.reload();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toContainText(response);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.creates.length),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.sends.length),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Append to reply", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(`My original thought.\n\n${response}`);
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Replace existing reply…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm replacement", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(response);
});

test("lost create and turn acknowledgements recover the same durable requests", async ({
  page,
}) => {
  await openReply(page, "&lostcreate&lostturn");
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry session", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Agent draft instructions" })
    .fill("Confirm Tuesday.");
  await page
    .getByRole("button", { name: "Generate draft", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Agent draft instructions" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry generation", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toContainText(response);
  const calls = await page.evaluate(() => {
    const f = (window as any).prismReplyAgent;
    return { creates: f.creates, sends: f.sends };
  });
  expect(calls.creates).toHaveLength(2);
  expect(calls.creates[0].requestId).toBe(calls.creates[1].requestId);
  expect(calls.sends).toHaveLength(2);
  expect(calls.sends[0].requestId).toBe(calls.sends[1].requestId);
});

test("closing a running draft does not start or cancel another run", async ({
  page,
}) => {
  await openReply(page, "&pending");
  await generate(page);
  await expect(
    page.getByText("The agent is preparing your reply.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close agent draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.sends.length),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.cancellations),
  ).toBe(0);
  await page.evaluate(() => (window as any).prismReplyAgent.complete());
  await page
    .getByRole("button", { name: "Check saved response", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toContainText(response);
});

test("changing Cc isolates the agent result while keeping the human reply", async ({
  page,
}) => {
  await openReply(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Original reply.");
  await generate(page);
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close agent draft", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Reply Cc" })
    .fill("rowan@example.test");
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate draft", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.creates.length),
  ).toBe(2);
  await page
    .getByRole("button", { name: "Close agent draft", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Original reply.");
});

test("a send resolving after the reply unmounts cannot attach a leaked stream", async ({
  page,
}) => {
  await openReply(page, "&deferred");
  await generate(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).prismReplyAgent.deferred.length),
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Close agent draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close email reply", exact: true })
    .click();
  await page.evaluate(() =>
    (window as any).prismReplyAgent.deferred
      .splice(0)
      .forEach((resolve: () => void) => resolve()),
  );
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.streams),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).prismReplyAgent.cancellations),
  ).toBe(0);
});

test("a late send continuation cannot retarget the next session in StrictMode", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html?lifecycle");
  await expect(page.getByText("Session: first", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start deferred turn" }).click();
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(
    page.getByText("Session: second", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).prismLifecycle.resolve());
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => (window as any).prismLifecycle.streams),
  ).toEqual([]);
  expect(
    await page.evaluate(() => (window as any).prismLifecycle.cancelled),
  ).toEqual([]);
});

test("revising instructions deliberately starts one new request, with a fresh retry identity", async ({
  page,
}) => {
  await openReply(page);
  await generate(page);
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revise instructions" }).click();
  await page
    .getByRole("textbox", { name: "Agent draft instructions" })
    .fill("Suggest Thursday instead.");
  await page
    .getByRole("button", { name: "Generate draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Revise instructions" }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).prismReplyAgent.sends,
  );
  expect(calls).toHaveLength(2);
  expect(calls[0].requestId).not.toBe(calls[1].requestId);
  expect(calls[1].prompt).toContain("Suggest Thursday instead.");
});

test("changing the authenticated audience removes the prior result and draft", async ({
  page,
}) => {
  await openReply(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Alex’s private draft.");
  await generate(page);
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).prismMessagesFixture.switchActor());
  await expect(
    page.getByRole("complementary", { name: "Agent reply draft" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Draft with agent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate draft", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toHaveCount(0);
});

test("changed session permissions disable insertion and generation", async ({
  page,
}) => {
  await openReply(page);
  await generate(page);
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("fixture-agent-reply:"),
    )!;
    const detail = JSON.parse(localStorage.getItem(key)!);
    detail.session.permission_mode = "read-write";
    localStorage.setItem(key, JSON.stringify(detail));
  });
  await page.getByRole("button", { name: "Insert into reply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("permissions changed");
  await page
    .getByRole("button", { name: "Check saved response", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Insert into reply", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert").first()).toContainText("permissions changed");
});

test("dark phone draft panel remains readable and keyboard escape returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReply(page);
  await page.evaluate(() => document.documentElement.classList.remove("light"));
  await generate(page);
  await expect(
    page.getByRole("region", { name: "Agent draft preview" }),
  ).toContainText(response);
  await page.screenshot({
    path: test.info().outputPath("agent-reply-390-dark.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Draft with agent", exact: true }),
  ).toBeFocused();
});

test("only the drafted message is inserted; the agent's remarks stay in the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReply(page, "&chatty");
  await generate(page);
  const preview = page.getByRole("region", { name: "Agent draft preview" });
  await expect(preview.locator(".prism-agent-draft-text")).toHaveText(response);
  await expect(preview.locator(".prism-agent-draft-note")).toHaveText("Here is a draft that confirms Tuesday:\n\nTell me if you would like it warmer.");
  await expect(preview).not.toContainText("<reply>");
  expect(await page.evaluate(() => (window as any).prismReplyAgent.sends[0].prompt)).toContain("between <reply> and </reply>");
  await page.getByRole("button", { name: "Insert into reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(response);
});

test("the reply is written into the panel as it arrives; it can be inserted only once it is saved", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReply(page, "&pending");
  await generate(page);
  const live = page.getByRole("region", { name: "Reply in progress" });
  await expect(live).toContainText("The agent is preparing your reply.");
  await expect(page.getByText("return later")).toHaveCount(0);
  const turnId = await page.evaluate(() => (window as any).prismReplyAgent.sends.at(-1).requestId).then((id) => `turn-${id}`);
  const say = (text: string) => page.evaluate(([turn, piece]) => (window as any).prismReplyAgent.emit({ t: "text_delta", blockId: "b1", text: piece, turnId: turn }), [turnId, text]);
  await say("<reply>\nThanks, Morgan. ");
  await say("Tuesday afternoon works well.");
  await expect(live).toContainText("The agent is writing your reply…");
  await expect(live.locator(".prism-agent-draft-text")).toHaveText("Thanks, Morgan. Tuesday afternoon works well.");
  // Still being written: nothing to insert yet.
  await expect(page.getByRole("button", { name: "Insert into reply", exact: true })).toHaveCount(0);
  // The answer sits above the instructions, as in a chat.
  const answer = (await live.boundingBox())!;
  const box = (await page.getByRole("textbox", { name: "Agent draft instructions" }).boundingBox())!;
  expect(answer.y).toBeLessThan(box.y);
});
