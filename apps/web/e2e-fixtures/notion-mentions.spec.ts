import { test, expect, type Page } from "@playwright/test";

/** NP-RF-02…07 + CO-01 (comment mentions) over the in-page fake server. */

const SHOTS = process.env.MENTION_SHOTS_DIR;
if (SHOTS) test.setTimeout(90_000);

async function openEditor(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/notion-mentions.html${query}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible();
  return editor;
}

/** Put the caret at the end of the document and start a fresh paragraph. */
async function typeAtEnd(page: Page, editor: ReturnType<Page["locator"]>, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

const saved = (page: Page, id: string) => page.evaluate((noteId) => (window as any).prismFixtureNotes.find((n: any) => n.id === noteId).content as string, id);

test("@ menu offers people, pages, dates", async ({ page }) => {
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Owner: @");
  const menu = page.getByRole("listbox", { name: "Mention a person, page or date" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("group", { name: "People" }).getByRole("option", { name: /Ada Lovelace/ })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Pages" }).getByRole("option", { name: /Project brief/ })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Dates" }).getByRole("option", { name: /Today/ })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Reminders" }).getByRole("option", { name: /Remind me/ })).toBeVisible();
  // Never offers the page you are writing in, nor a page you can't view.
  await expect(menu.getByRole("option", { name: /Launch plan/ })).toHaveCount(0);
  await expect(menu.getByRole("option", { name: /Salary review/ })).toHaveCount(0);

  // Filtering, natural-language dates, keyboard selection.
  await page.keyboard.type("tomorrow 9am");
  await expect(menu.getByRole("group", { name: "People" })).toHaveCount(0);
  await expect(menu.getByRole("option", { name: "Tomorrow 9:00", exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: "Remind me Tomorrow 9:00" })).toBeVisible();
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((t) => { document.documentElement.className = t; }, theme);
        await page.screenshot({ path: `${SHOTS}/mention-menu-${w}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.className = "light"; });
  }
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(editor.locator('[data-type="mention"][data-kind="date"]')).toContainText("Tomorrow 9:00");

  // Escape closes the menu and leaves the typed text.
  await page.keyboard.type(" and @gr");
  await expect(menu.getByRole("option", { name: /Grace Hopper/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toContainText("@gr");

  // Not inside an email address.
  await page.keyboard.type(" mail ada@exa");
  await expect(menu).toHaveCount(0);

  // Not mid-IME composition: the trigger stays closed while composing.
  await page.keyboard.type(" ");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "@か", selectionStart: 2, selectionEnd: 2 });
  await expect(menu).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "@か" });
});

test("person mention hover card + notifies", async ({ page }) => {
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Ask @ada");
  await page.getByRole("option", { name: /Ada Lovelace/ }).click();
  const chip = editor.locator('[data-type="mention"][data-kind="person"]');
  await expect(chip).toHaveText("@Ada Lovelace");
  await expect(chip).toHaveAttribute("data-mention-uid", /.+/);

  // Hover → name + linked identities.
  await chip.hover();
  const card = page.getByRole("tooltip", { name: "About Ada Lovelace" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Research lead");
  await expect(card.getByRole("list", { name: "Linked identities" })).toContainText("ada@example.test");
  await expect(card).toContainText("@ada:example.test");

  // Saved content carries the chip (id + name, never an email) → the server notifies on store.
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toContain('data-kind="person"');
  const html = await saved(page, "plan");
  expect(html).toContain('data-id="p-ada"');
  expect(html).not.toContain("ada@example.test");

  // Click → People profile.
  await page.mouse.move(0, 0);
  await chip.locator(".prism-mention-chip").click();
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs.map((t: any) => t.noteId))).toContain("people:p-ada");
});

test("page mention tracks rename; no-access state", async ({ page }) => {
  const editor = await openEditor(page, "?open=refs");
  const brief = editor.locator('[data-mention-uid="u-brief"]');
  await expect(brief).toContainText("Project brief");
  await expect(brief).toContainText("🧭");
  // A page the reader can't view: "No access" — and never its title.
  const secret = editor.locator('[data-mention-uid="u-secret"]');
  await expect(secret).toContainText("No access");
  await expect(editor).not.toContainText("Salary review");
  // A trashed page.
  await expect(editor.locator('[data-mention-uid="u-old"]')).toContainText("Deleted page");
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((t) => { document.documentElement.className = t; }, theme);
        await page.screenshot({ path: `${SHOTS}/mention-chips-${w}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.className = "light"; });
  }
  // The stored HTML holds no page title at all.
  expect(await saved(page, "refs")).not.toContain("Project brief");

  // Hover preview.
  await brief.hover();
  await expect(page.getByRole("tooltip", { name: "Preview of Project brief" })).toContainText("spring launch");
  await page.mouse.move(0, 0);

  // Open the page through the chip and rename it: the chip follows the live title.
  await brief.locator(".prism-mention-chip").click();
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureUI.getState().activeTabId)).toBe("tab-brief");
  await page.getByRole("button", { name: "Rename Project brief" }).click();
  const titleBox = page.getByRole("textbox", { name: "Document title" });
  await titleBox.fill("Launch brief");
  await titleBox.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureNotes.find((n: any) => n.id === "brief").path)).toBe("vault/Projects/Launch brief");
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("refs", "References", "document"));
  await expect(page.locator('.ProseMirror [data-mention-uid="u-brief"]')).toContainText("Launch brief", { timeout: 10_000 });
  expect(await saved(page, "refs")).not.toContain("Launch brief");
});

test("date chip edit and relative display", async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 1, 10, 0) });
  const editor = await openEditor(page, "?open=refs");
  const date = editor.locator('[data-mention-uid="u-date"]');
  await expect(date).toContainText("Tomorrow"); // 2026-10-02 seen on 2026-10-01
  await date.locator(".prism-mention-chip").click();
  const dialog = page.getByRole("dialog", { name: "Edit date" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Friday, October 2, 2026");
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((t) => { document.documentElement.className = t; }, theme);
        await page.screenshot({ path: `${SHOTS}/mention-date-${w}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.className = "light"; });
  }
  await dialog.getByLabel("Date").fill("2026-10-01");
  await dialog.getByLabel("Time", { exact: true }).fill("15:30");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(date).toContainText("Today 15:30");
  // Stored as an instant with the author's offset; a date-only chip stays a calendar day.
  await expect.poll(() => saved(page, "refs"), { timeout: 10_000 }).toMatch(/data-date="2026-10-01T15:30:00[+-]\d\d:\d\d"/);

  // Weekday + far dates, timezone-correct relative to the reader's clock.
  await date.locator(".prism-mention-chip").click();
  await dialog.getByLabel("Date").fill("2026-10-05");
  await dialog.getByLabel("Time", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(date).toContainText("Monday");
  await expect.poll(() => saved(page, "refs"), { timeout: 10_000 }).toContain('data-date="2026-10-05"');
});

test("reminder lands in inbox at time", async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 1, 10, 0) });
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Follow up @remind tomorrow 9am");
  await page.getByRole("option", { name: "Remind me Tomorrow 9:00" }).click();
  const chip = editor.locator('[data-type="mention"][data-kind="date"]');
  await expect(chip).toHaveAttribute("data-reminder", "r1");
  await expect(page.getByRole("status").filter({ hasText: "Reminder set for Tomorrow 9:00" })).toBeVisible();
  const posted = await page.evaluate(() => (window as any).prismFixtureWrites.find((w: any) => w.reminder)?.reminder);
  expect(posted).toMatchObject({ noteId: "plan", dateOnly: false });
  expect(new Date(posted.at).getTime()).toBe(new Date(2026, 9, 2, 9, 0).getTime());
  expect(typeof posted.tz).toBe("string");

  // Before the time: nothing in the inbox.
  const inbox = () => page.evaluate(async () => (await (await fetch("/api/notifications")).json()).items);
  expect(await inbox()).toEqual([]);
  // After the time: a reminder item that deep-links to the chip.
  await page.clock.setSystemTime(new Date(2026, 9, 2, 9, 1));
  const items = await inbox();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "reminder", noteId: "plan", anchor: { reminder: "r1" } });
  await expect(page.locator('[data-reminder="r1"]')).toHaveCount(1);

  // Cancel from the chip: the reminder is deleted server-side and the attr cleared.
  await chip.locator(".prism-mention-chip").click();
  const dialog = page.getByRole("dialog", { name: "Edit date" });
  await dialog.getByLabel("Remind me").uncheck();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(chip).not.toHaveAttribute("data-reminder", /.+/);
  expect(await page.evaluate(() => (window as any).prismFixtureReminders[0].status)).toBe("cancelled");
});

test("mention appears in target backlinks", async ({ page }) => {
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Depends on @retro");
  await page.getByRole("option", { name: /Retro notes/ }).click();
  await expect(editor.locator('[data-type="mention"][data-kind="page"]')).toContainText("Retro notes");
  await expect.poll(() => saved(page, "plan"), { timeout: 10_000 }).toContain('data-id="retro"');
  // Open the target and its Links panel: the mentioning page is a backlink.
  await page.evaluate(() => {
    const ui = (window as any).prismFixtureUI.getState();
    ui.openTab("retro", "Retro notes", "document");
    (window as any).prismFixtureUI.setState({ contextPanelOpen: true, contextPanelTab: "links" });
  });
  const incoming = page.getByRole("region", { name: "Links to this page" });
  await expect(incoming).toBeVisible({ timeout: 10_000 });
  await expect(incoming.getByRole("button", { name: "Open Launch plan" })).toBeVisible();
  await expect(incoming).toContainText("mentions");
});

test("comment mention, edit own, reopen", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-mentions.html?comments");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready");
  await editor.click();
  await page.evaluate(() => (window as any).prismMentionsFixture.select("rollout plan"));
  await page.getByRole("button", { name: "Comment on selection" }).click();
  const box = page.getByRole("textbox", { name: "Comment" });
  await expect(box).toBeFocused();
  await box.pressSequentially("Can @gra");
  const picker = page.getByRole("listbox", { name: "Mention a person" });
  await expect(picker.getByRole("option", { name: /Grace Hopper/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("Can @[Grace Hopper](person:p-grace) ");
  await box.pressSequentially("review this?");
  await page.keyboard.press("ControlOrMeta+Enter");

  const panel = page.getByRole("complementary", { name: "Comments panel" });
  const mention = panel.getByRole("link", { name: "Person: Grace Hopper" });
  await expect(mention).toHaveText("@Grace Hopper");
  await expect(panel).toContainText("review this?");

  // Edit own comment (mentions work in edits too).
  await panel.getByRole("button", { name: "Edit comment" }).click();
  const edit = panel.getByRole("textbox", { name: "Edit comment" });
  await edit.fill("");
  await edit.pressSequentially("Over to @ad");
  await expect(panel.getByRole("option", { name: /Ada Lovelace/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("link", { name: "Person: Ada Lovelace" })).toBeVisible();
  await expect(panel).toContainText("(edited)");
  await expect(panel.getByRole("link", { name: "Person: Grace Hopper" })).toHaveCount(0);

  // Reply with a mention, then resolve → Resolved tab → reopen.
  const reply = panel.getByRole("textbox", { name: "Reply" });
  await reply.pressSequentially("Thanks @gra");
  await expect(panel.getByRole("option", { name: /Grace Hopper/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await reply.press("Enter");
  await expect(panel.getByRole("link", { name: "Person: Grace Hopper" })).toBeVisible();
  await panel.getByTitle("Resolve").click();
  await expect(panel).toContainText("No open comments.");
  await panel.getByRole("button", { name: /Resolved/ }).click();
  await panel.getByRole("button", { name: "Reopen" }).click();
  await panel.getByRole("button", { name: /Open/ }).first().click();
  await expect(panel.getByRole("link", { name: "Person: Ada Lovelace" })).toBeVisible();
  const stored = JSON.stringify(await page.evaluate(() => (window as any).prismMentionsFixture.comments()));
  expect(stored).toContain("@[Ada Lovelace](person:p-ada)");
  expect(stored).toContain("\"resolved\":false");
});

// Wave 3 gaps #10: a workspace member with no person page is mentioned by account.
test("@ menu lists workspace members without a person page; the chip stores an opaque id, never an email", async ({ page }) => {
  const editor = await openEditor(page);
  await typeAtEnd(page, editor, "Ask @cal");
  const menu = page.getByRole("listbox", { name: "Mention a person, page or date" });
  const option = menu.getByRole("group", { name: "People" }).getByRole("option", { name: /Cal Newport/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText("Workspace member");
  await expect(option).not.toContainText("@example");
  await expect(menu.getByRole("option", { name: /Ada Lovelace/ })).toHaveCount(0); // the debounced people query caught up
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const chip = editor.locator('[data-type="mention"][data-kind="person"]').filter({ hasText: "Cal Newport" });
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".prism-mention-chip")).toHaveAttribute("data-account", "true");
  await expect(chip.locator(".prism-mention-chip")).toHaveAttribute("aria-label", "Member: Cal Newport");
  // Saved HTML: the existing attributes only — the opaque id and the display name.
  await expect.poll(() => saved(page, "plan")).toContain('data-id="u_0123456789abcdef"');
  const html = await saved(page, "plan");
  expect(html).toContain('data-label="Cal Newport"');
  expect(html).not.toMatch(/cal@|newport@/i);
  // Hovering opens no profile card and requests no profile.
  await chip.hover();
  await page.waitForTimeout(600);
  await expect(page.getByText("Open profile")).toHaveCount(0);
});
