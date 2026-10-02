import { test, expect, type Page } from "@playwright/test";
const url = "/e2e-fixtures/agent.html?handoff&context&attachments&history";
const add = (page: Page) =>
  page.getByRole("button", {
    name: "Add Reference note to context",
    exact: true,
  });
const notice = (page: Page) =>
  page.getByRole("region", { name: "Saved note context" });
const ids = (page: Page) =>
  page.evaluate(() =>
    JSON.parse((window as any).prismContextMirror.text || "[]"),
  );
async function noSend(page: Page) {
  expect(
    await page.evaluate(() => {
      const c = (window as any).prismAgentFixture;
      return [c.attempts, c.turnAttempts, c.queueAttempts];
    }),
  ).toEqual([0, 0, 0]);
}

test("search attaches to the current session without changing its draft, mode or working page", async ({
  page,
}, info) => {
  await page.goto(url);
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("Keep this instruction");
  await page
    .getByLabel("Agent permissions", { exact: true })
    .selectOption("suggest");
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("Reference");
  await expect(
    search.getByRole("button", { name: "Add Reference note to context" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("search-context-desktop.png"),
  });
  await page.keyboard.press("Escape");
  await add(page).click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  expect(await page.evaluate(() => (window as any).prismAgentFixture.sourceReads.some((read: {id:string;fresh?:boolean}) => read.id === "document-b" && read.fresh === true))).toBe(true);
  await expect(input).toHaveValue("Keep this instruction");
  await expect(
    page.getByLabel("Agent permissions", { exact: true }),
  ).toHaveValue("suggest");
  expect(
    await page.evaluate(
      () => (window as any).prismAgentStore.getState().activeSessionId,
    ),
  ).toBe("fixture-session");
  await noSend(page);
  await page.screenshot({ path: info.outputPath("saved-context-desktop.png") });
  await add(page).click();
  await expect(notice(page)).toHaveCount(0);
  expect(await ids(page)).toEqual(["document-b"]);
});
test("command search has a separate keyboard action and neutral new draft", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url.replace("&history", "").replace("&context", ""));
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("combobox").fill("Reference");
  const action = dialog.getByRole("button", {
    name: "Add Reference note to context",
  });
  await expect(action).toBeVisible();
  await page.screenshot({ path: info.outputPath("search-context-mobile.png") });
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  expect(
    await page.evaluate(() => (window as any).prismAgentStore.getState().draft),
  ).toEqual({});
  await noSend(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("saved-context-mobile.png") });
});
test("fresh access denial retains the handoff for retry and a second click cannot overwrite it", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.denySource = true;
  });
  await add(page).click();
  await expect(notice(page)).toContainText("Couldn't check access");
  await expect(
    page.getByRole("button", { name: "Finish or dismiss pending context" }),
  ).toBeDisabled();
  expect(await ids(page)).toEqual([]);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.denySource = false;
  });
  await page.getByRole("button", { name: "Check note again" }).click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  await noSend(page);
});
test("a second view's attachment survives a pending access check; limits preserve pending note", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.holdSource = true;
  });
  await add(page).click();
  await expect(notice(page)).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismContextMirror.setText(
      JSON.stringify([
        "source-1",
        "source-2",
        "source-3",
        "source-4",
        "source-5",
      ]),
    );
    const c = (window as any).prismAgentFixture;
    c.holdSource = false;
    c.releaseSources.splice(0).forEach((f: () => void) => f());
  });
  await expect(notice(page)).toContainText("Remove an attached note");
  await page.evaluate(() => {
    (window as any).prismContextMirror.updateText((raw: string) =>
      JSON.stringify(JSON.parse(raw).slice(0, 4)),
    );
  });
  await expect
    .poll(() => ids(page))
    .toEqual(["source-1", "source-2", "source-3", "source-4", "document-b"]);
  await noSend(page);
});
test("destination changes require a choice and scope changes cancel late access responses", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.holdSource = true;
  });
  await add(page).click();
  await expect(notice(page)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).prismAgentStore.getState();
    s.setActiveSession(null);
    s.setDraft({ noteId: "document-c", noteTitle: "Other page" });
    const c = (window as any).prismAgentFixture;
    c.holdSource = false;
    c.releaseSources.splice(0).forEach((f: () => void) => f());
  });
  await expect(notice(page)).toContainText("You switched conversations");
  expect(await ids(page)).toEqual([]);
  await page
    .getByRole("button", { name: "Attach to this conversation" })
    .click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.holdSource = true;
  });
  await add(page).click();
  await expect(notice(page)).toBeVisible();
  await page.getByRole("button", { name: "Morgan", exact: true }).click();
  await page.evaluate(() => {
    const c = (window as any).prismAgentFixture;
    c.holdSource = false;
    c.releaseSources.splice(0).forEach((f: () => void) => f());
  });
  await expect(notice(page)).toHaveCount(0);
  expect(await ids(page)).toEqual([]);
  await noSend(page);
});
test("storage write failure retains attachment in memory with its existing warning", async ({
  page,
}) => {
  await page.goto(url);
  await expect(add(page)).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("denied");
    };
  });
  await add(page).click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  await expect(
    page.getByText(
      "This draft is only held in this window. Keep it open or copy the text before leaving.",
      { exact: true },
    ),
  ).toBeVisible();
  await noSend(page);
});
test("in-flight send waits; confirmed successful turn clears receipt and permits attachment", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.holdTurn = true;
  });
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Original message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).prismAgentFixture.releaseTurn),
    )
    .toBe(true);
  await add(page).click();
  await expect(notice(page)).toContainText("Waiting for the current send");
  expect(await ids(page)).toEqual([]);
  await page.evaluate(() => {
    const c = (window as any).prismAgentFixture;
    c.holdTurn = false;
    c.releaseTurn();
  });
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  expect(
    await page.evaluate(
      () => (window as any).prismAgentFixture.lastOptions?.contextNoteIds,
    ),
  ).toBeUndefined();
});
test("uncertain ordinary receipt blocks attachment across reload without changing receipt or draft", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).prismAgentFixture.rejectTurn = true;
  });
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("Retry unchanged");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("Fixture turn rejected", { exact: false }),
  ).toBeVisible();
  await add(page).click();
  await expect(notice(page)).toContainText("Confirm the previous send");
  const receipts = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("prism:agent-request:"),
    ),
  );
  await page.reload();
  await add(page).click();
  await expect(notice(page)).toContainText("Confirm the previous send");
  await expect(input).toHaveValue("Retry unchanged");
  expect(await ids(page)).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) =>
        key.startsWith("prism:agent-request:"),
      ),
    ),
  ).toEqual(receipts);
});
test("malformed receipt and denied receipt reads block handoff without clearing data", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => {
    const scope = (window as any).prismAgentStore.getState().scope;
    localStorage.setItem(
      `prism:agent-request:v1:${JSON.stringify([scope, "session:fixture-session"])}`,
      "malformed",
    );
  });
  await add(page).click();
  await expect(notice(page)).toContainText("Confirm the previous send");
  await page.getByRole("button", { name: "Dismiss pending note" }).click();
  await page.evaluate(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith("prism:agent-request:")) throw Error("denied");
      return get.call(this, key);
    };
  });
  await add(page).click();
  await expect(notice(page)).toContainText("Couldn't check your previous send");
  expect(await ids(page)).toEqual([]);
  await noSend(page);
});

test("queued retry bytes stay unchanged while saved context waits", async ({
  page,
}) => {
  await page.goto(url + "&queue");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Queue follow-up" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismAgentFixture.loseQueueResponse = true;
  });
  await page
    .getByRole("textbox", { name: "Message the agent" })
    .fill("Exact queued draft");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(
    page.getByRole("button", { name: "Check queued message" }),
  ).toBeVisible();
  const bytes = await page.evaluate(() =>
    Object.entries(localStorage).filter(
      ([key]) =>
        key.includes("pending-followup:") || key.includes("followups:"),
    ),
  );
  await add(page).click();
  await expect(notice(page)).toContainText("Waiting for the current send");
  expect(await ids(page)).toEqual([]);
  await expect(
    page.getByRole("textbox", { name: "Message the agent" }),
  ).toHaveValue("Exact queued draft");
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).filter(
        ([key]) =>
          key.includes("pending-followup:") || key.includes("followups:"),
      ),
    ),
  ).toEqual(bytes);
  await page.getByRole("button", { name: "Check queued message" }).click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
});
test("saved-note handoff and selected passage coexist without overwriting either", async ({
  page,
}) => {
  await page.goto(url + "&snapshots");
  await page.evaluate(() => {
    (window as any).prismAgentFixture.holdSource = true;
  });
  await add(page).click();
  await expect(notice(page)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).prismAgentStore.getState();
    s.beginSelection({
      kind: "selection",
      noteId: "document-a",
      label: "Selected passage",
      text: "Independent captured text",
      capturedAt: new Date().toISOString(),
      truncated: false,
      baseUpdatedAt: null,
    });
  });
  await expect(
    page.getByRole("button", { name: "Selected passage", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const c = (window as any).prismAgentFixture;
    c.holdSource = false;
    c.releaseSources.splice(0).forEach((f: () => void) => f());
  });
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  await expect(
    page.getByRole("button", { name: "Selected passage", exact: true }),
  ).toBeVisible();
  await noSend(page);
});

test("unavailable agent provider exposes no context action", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/search.html?no-agent");
  await expect(
    page.getByRole("button", { name: /Connected ideas/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /to context/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("combobox").fill("ideas");
  await expect(
    dialog.getByRole("option", { name: /Connected ideas/ }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: /to context/ })).toHaveCount(
    0,
  );
});

test("a new draft on the same note requires explicit destination confirmation", async ({
  page,
}) => {
  await page.goto(url.replace("&history", ""));
  await page.evaluate(() => {
    const s = (window as any).prismAgentStore.getState();
    s.setDraft({ noteId: "document-a" });
    (window as any).prismAgentFixture.holdSource = true;
  });
  await add(page).click();
  await expect(notice(page)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).prismAgentStore.getState();
    s.setDraft({ noteId: "document-a" });
    const c = (window as any).prismAgentFixture;
    c.holdSource = false;
    c.releaseSources.splice(0).forEach((f: () => void) => f());
  });
  await expect(notice(page)).toContainText("You switched conversations");
  expect(await ids(page)).toEqual([]);
  await page
    .getByRole("button", { name: "Attach to this conversation" })
    .click();
  await expect.poll(() => ids(page)).toEqual(["document-b"]);
  await noSend(page);
});
