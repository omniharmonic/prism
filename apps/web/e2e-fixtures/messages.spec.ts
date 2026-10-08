import { test, expect } from "@playwright/test";
import { parseLegacyThread } from "../../../packages/core/src/lib/messages/legacyThread";
import { parseEmailContent } from "../../../packages/core/src/lib/messages/emailThread";

test("legacy transcripts retain multiline content and colon-bearing identities in UTC", () => {
  const parsed = parseLegacyThread(
    "# Conversation\n\n[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:16] Alex: Next message",
  );
  expect(parsed.preamble).toBe("# Conversation");
  expect(parsed.messages).toHaveLength(2);
  expect(parsed.messages[0].sender).toBe("@morgan:example.test");
  expect(parsed.messages[0].body).toBe("First line\nSecond line\n\n- A list");
  expect(parsed.messages[0].timestamp).toBe(Date.UTC(2026, 9, 1, 10, 15));
  expect(parsed.messages[0].source).toBe("legacy");
  const prepended = parseLegacyThread(
    "[2026-09-30 10:15] Alex: Earlier\n" +
      "[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:16] Alex: Next message",
  );
  expect(prepended.messages[1].event_id).toBe(parsed.messages[0].event_id);
  expect(
    parseLegacyThread("[2026-02-31 10:15] Alex: Invalid date").messages[0]
      .timestamp,
  ).toBe(0);
});

test("failed sends retain a draft and acknowledged sends clear it once", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Please keep this reply.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is kept here",
  );
  await expect(input).toHaveValue("Please keep this reply.");
  await page.evaluate(() => {
    (
      window as unknown as { prismMessagesFixture: { reject: boolean } }
    ).prismMessagesFixture.reject = false;
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByText("Please keep this reply.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { prismMessagesFixture: { attempts: number } })
          .prismMessagesFixture.attempts,
    ),
  ).toBe(2);
});

test("reading position survives incoming messages and prepended history", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html");
  const thread = page.getByRole("region", { name: "Conversation messages" });
  await expect(thread.locator("article")).toHaveCount(30);
  await thread.evaluate((node) => {
    node.scrollTop = 200;
    node.dispatchEvent(new Event("scroll"));
  });
  await page.getByRole("button", { name: "Receive message" }).click();
  expect(await thread.evaluate((node) => node.scrollTop)).toBe(200);
  await expect(
    page.getByRole("button", { name: "New messages" }),
  ).toBeVisible();
  const before = await thread
    .locator('[data-message-id="event-12"]')
    .boundingBox();
  await page.getByRole("button", { name: "Prepend history" }).click();
  const after = await thread
    .locator('[data-message-id="event-12"]')
    .boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await page.getByRole("button", { name: "New messages" }).click();
  expect(
    await thread.evaluate(
      (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
    ),
  ).toBeLessThan(2);
});

test("mobile messages wrap without losing line breaks or sender labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/messages.html");
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".workspace-message-body")
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace),
  ).toBe("pre-wrap");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "test-results/messages-mobile.png",
    animations: "disabled",
  });
});

test("saved thread renders all lines and unavailable reply cannot clear a draft", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace.html?thread");
  await expect(
    page.getByRole("region", { name: "Conversation messages" }),
  ).toBeVisible();
  await expect(page.locator(".workspace-message-body").first()).toContainText(
    "Second line",
  );
  await expect(
    page.getByText("@morgan:example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Replying is unavailable for this thread on this connection.",
    ),
  ).toBeVisible();
});

test("message drafts follow their account and destination through navigation and reload", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Alex's reply for Room A");
  await page.getByRole("button", { name: "Room B", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("A different room draft");
  await page.getByRole("button", { name: "Room A", exact: true }).click();
  await expect(input).toHaveValue("Alex's reply for Room A");
  await page
    .getByRole("button", { name: "Morgan account", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(input).toHaveValue("Alex's reply for Room A");
  expect(
    await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
  ).toBe(0);
});

test("a lost message acknowledgement reuses its original request after reload", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html?lost");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Send this message once");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "lost response after acceptance",
  );
  await page.reload();
  await expect(input).toHaveValue("Send this message once");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fixture-message-accepted") ?? "[]"),
    ),
  ).toHaveLength(1);
});

test("expired message receipts cannot silently outlive server deduplication", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html?lost");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("An old unconfirmed send");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "lost response after acceptance",
  );
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("prism:message-request:"),
    )!;
    const receipt = JSON.parse(localStorage.getItem(key)!);
    receipt.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(key, JSON.stringify(receipt));
  });
  await page.reload();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "too old to retry safely",
  );
  await expect(input).toHaveValue("An old unconfirmed send");
  expect(
    await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
  ).toBe(0);
});

test("live action retries and late acknowledgements cannot cross audiences", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html");
  const result = await page.evaluate(async () => {
    let scope = "first-owner-vault";
    let attempts = 0;
    const factory = (window as any).prismActionsFactory;
    const client = factory({
      scope: () => scope,
      fetch: async () => {
        attempts++;
        scope = "second-owner-vault";
        throw new TypeError("Connection dropped");
      },
    });
    let retryError = "";
    try {
      await client.matrixSend("room-a", "private draft");
    } catch (error) {
      retryError = (error as Error).message;
    }
    scope = "first-owner-vault";
    const late = factory({
      scope: () => scope,
      fetch: async () => ({
        ok: true,
        json: async () => {
          scope = "second-owner-vault";
          return { eventId: "accepted" };
        },
      }),
    });
    let lateError = "";
    try {
      await late.matrixSend("room-a", "private draft");
    } catch (error) {
      lateError = (error as Error).message;
    }
    const malformed = factory({
      fetch: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Incomplete acknowledgement");
        },
      }),
    });
    let malformedError = "";
    try {
      await malformed.matrixSend("room-a", "private draft");
    } catch (error) {
      malformedError = (error as Error).message;
    }
    return { attempts, retryError, lateError, malformedError };
  });
  expect(result.attempts).toBe(1);
  expect(result.retryError).toContain("Workspace changed");
  expect(result.lateError).toContain("Workspace changed");
  expect(result.malformedError).toContain("Incomplete acknowledgement");
});

test("email import readers preserve body headings, rules, header-like prose and message authors", () => {
  const body =
    "# Body heading\nword---word\n\n---\n\n**From:** quoted text\nBody ends.";
  const proton = parseEmailContent(
    `# Subject\n\n**From:** Morgan\n**To:** Alex\n**Date:** Today\n**Attachments:** plan.pdf\n\n---\n\n${body}`,
    "",
    "",
    "proton-bridge",
  );
  expect(proton).toEqual([
    {
      from: "Morgan",
      date: "Today",
      details: ["To: Alex", "Attachments: plan.pdf"],
      body,
    },
  ]);
  const legacy = parseEmailContent(
    `# Subject\n\n**From:** Morgan  \n**Date:** Today\n\n${body}\n\n---\n\n**From:** Alex\n**Date:** Tomorrow\n\nSecond reply\n\n---\n\n`,
    "",
    "",
  );
  expect(legacy).toHaveLength(2);
  expect(legacy[0].body).toBe(body);
  expect(legacy[1]).toMatchObject({ from: "Alex", body: "Second reply" });
  expect(parseEmailContent(body, "Fallback", "Unknown")[0].body).toBe(body);
});

test("email reply keeps its multiline draft on close and retries the original send after reload", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/messages.html?email");
  await expect(
    page.getByText("# A heading inside the message", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("A careful reply");
  await input.press("End");
  await input.press("Enter");
  await expect(input).toHaveValue("A careful reply\n");
  await page.getByRole("button", { name: "Close email reply" }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(input).toHaveValue("A careful reply\n");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "lost email acknowledgement",
  );
  await page.reload();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(input).toHaveValue("A careful reply\n");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Reply sent.", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fixture-email-accepted") ?? "[]"),
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("email-mobile.png") });
});

test("unavailable server email never falls through to native reply commands", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html?email&unavailable");
  await expect(
    page.getByRole("button", { name: "Reply", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Replying is turned off on this server.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
  ).toBe(0);
});

// Owner report (iOS, server with ACTIONS_EMAIL_ENABLED=false): "tapping Reply
// doesn't open a new input". Reply was greyed out with its only explanation a
// faint line at the very bottom of the pane; and where replying IS possible the
// composer opened without the caret in it.
for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test(`Reply opens a focused composer inside the viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/e2e-fixtures/messages.html?email");
    const reply = page.getByRole("button", { name: "Reply", exact: true });
    await expect(reply).toBeEnabled();
    await expect(page.locator(".prism-email-unavailable")).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toHaveCount(0);
    await reply.click();
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("Replying to morgan@example.test")).toBeInViewport();
    await page.keyboard.type("Typed without tapping the field");
    await expect(input).toHaveValue("Typed without tapping the field");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
    ).toBe(0);
  });

  test(`Reply that cannot work says why beside the button at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/e2e-fixtures/messages.html?email&unavailable");
    const reply = page.getByRole("button", { name: "Reply", exact: true });
    await expect(reply).toBeDisabled();
    const reason = page.getByText("Replying is turned off on this server.", {
      exact: true,
    });
    await expect(reason).toBeVisible();
    await expect(reply).toHaveAccessibleDescription(
      "Replying is turned off on this server.",
    );
    // Beside the control it explains — not at the far end of the pane, where a
    // phone's bottom bar covers it.
    const button = (await reply.boundingBox())!;
    const text = (await reason.boundingBox())!;
    expect(text.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(text.y - (button.y + button.height)).toBeLessThan(24);
    // The sibling mailbox actions are not offered at all, and no composer exists.
    await expect(
      page.getByRole("button", { name: "Archive", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Mark (read|unread)/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
    ).toBe(0);
  });
}

for (const [query, reason] of [
  ["unconfigured", "The server has no mail credential yet, so it can't send a reply."],
  ["notowner", "Only the server owner can reply to email from Prism."],
  ["nomessageid", "This email was saved without a message ID, so Prism can't reply to it."],
] as const)
  test(`unavailable email reply names its cause: ${query}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e-fixtures/messages.html?email&${query}`);
    const reply = page.getByRole("button", { name: "Reply", exact: true });
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(reply).toBeDisabled();
    await expect(reply).toHaveAccessibleDescription(reason);
    await expect(
      page.getByRole("button", { name: "Archive", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
    ).toBe(0);
  });

test("read-only email never exposes reply or mailbox mutation actions", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/messages.html?email&readonly");
  await expect(
    page.getByRole("button", { name: "Reply", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Mark (read|unread)/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("You can read this email but not reply to it.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismMessagesFixture.attempts),
  ).toBe(0);
});

test("legacy native email requires an explicit account and readonly drafts cannot send", async ({
  page,
}) => {
  await page.goto(
    "/e2e-fixtures/messages.html?email&native&unavailable&noaccount",
  );
  await expect(
    page.getByRole("button", { name: "Reply", exact: true }),
  ).toBeDisabled();
  await page.goto(
    "/e2e-fixtures/messages.html?email&native&unavailable&noaccount&draft",
  );
  await expect(
    page.getByRole("textbox", { name: "Sending account" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.goto("/e2e-fixtures/messages.html?email&readonly&draft");
  await expect(
    page.getByRole("textbox", { name: "Email recipients" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});


test("explicit Cc survives close and changes send identity without losing the body draft", async ({ page }) => {
  await page.goto("/e2e-fixtures/messages.html?email");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Reply recipients" })).toHaveValue("morgan@example.test");
  await page.getByRole("textbox", { name: "Reply Cc" }).fill("not an address");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A reply with explicit recipients.");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Reply Cc" }).fill("reviewer@example.test");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sending was not confirmed");
  await page.getByRole("button", { name: "Close email reply" }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Reply Cc" })).toHaveValue("reviewer@example.test");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("A reply with explicit recipients.");
  await page.getByRole("textbox", { name: "Reply Cc" }).fill("other-reviewer@example.test");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sending was not confirmed");
  const calls = await page.evaluate(() => (window as any).prismMessagesFixture.replyCalls);
  expect(calls[0].params.cc).toEqual(["reviewer@example.test"]);
  expect(calls[1].params.cc).toEqual(["other-reviewer@example.test"]);
  expect(calls[0].key).not.toBe(calls[1].key);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Reply sent.", { exact: true })).toBeVisible();
  const retried = await page.evaluate(() => (window as any).prismMessagesFixture.replyCalls);
  expect(retried[2].key).toBe(retried[1].key);
});
