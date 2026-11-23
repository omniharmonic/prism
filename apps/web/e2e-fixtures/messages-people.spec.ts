/**
 * Messages → People over the server's read-time resolution (fixture `inbox.html?resolved`:
 * people with addresses / handles, mail, chats and a meeting — and NOT ONE stored link,
 * like the production vault). The old tab read graph links only and was empty there.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.W16_SHOTS; // optional: a directory for before/after screenshots
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
};
const theme = (page: Page, light: boolean) => page.evaluate((on) => document.documentElement.classList.toggle("light", on), light);
async function people(page: Page) {
  await page.goto("/e2e-fixtures/inbox.html?resolved");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  await page.getByRole("button", { name: "People", exact: true }).click();
}
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("People lists everyone with conversations, most recent first, with no stored link at all", async ({ page }) => {
  await people(page);
  const rows = page.getByRole("list", { name: "People with conversations" }).getByRole("button");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Mira Chen");
  await expect(rows.nth(1)).toContainText("Rowan Ellis");
  // Platform badges and the count on the row; an unread mail is flagged.
  for (const label of ["Telegram", "Email", "Meeting", "3 conversations"]) await expect(rows.nth(0)).toContainText(label);
  await expect(rows.nth(0).getByRole("img", { name: "1 unread" })).toBeVisible();
  await expect(rows.nth(1)).toContainText("Signal");
  // A display name is not an identity: River's WhatsApp thread names them, and they are not listed.
  await expect(page.getByRole("button", { name: /River Stone/ })).toHaveCount(0);
  await expect(page.getByText(/2 people/)).toBeVisible();
  // The graph and the 2,000-person listing are not what this view reads any more.
  expect(await page.evaluate(() => (window as any).prismInboxFixture.graphReads)).toBe(0);
});

test("selecting a person shows ONE merged timeline with source badges; an item opens the real thread", async ({ page }) => {
  await people(page);
  await page.getByRole("button", { name: /Mira Chen/ }).click();
  const timeline = page.getByRole("region", { name: "Conversations with Mira Chen" });
  const items = timeline.locator(".prism-timeline-item");
  await expect(items).toHaveCount(3);
  // Chronological across platforms, newest first, each badged with where it lives.
  await expect(items.nth(0)).toContainText("Workshop planning");
  await expect(items.nth(0)).toHaveAttribute("data-platform", "telegram");
  await expect(items.nth(0)).toContainText("Telegram");
  await expect(items.nth(1)).toContainText("Saturday workshop agenda");
  await expect(items.nth(1)).toContainText("Email");
  await expect(items.nth(2)).toContainText("Budget review");
  await expect(items.nth(2)).toContainText("Meeting");
  // Day separators carry an explicit date.
  await expect(timeline.getByRole("separator").first()).toHaveAttribute("aria-label", /October 6, 2026/);
  await expect(timeline.getByRole("separator")).toHaveCount(2);
  await shot(page, "people-timeline-desktop-light");
  await theme(page, false);
  await shot(page, "people-timeline-desktop-dark");
  await theme(page, true);

  await items.nth(0).click();
  const detail = page.getByRole("region", { name: "Selected conversation" });
  await expect(detail.getByRole("region", { name: "Conversation messages" })).toBeVisible();
  // One compact header: Back and Open as page live in the thread's own header.
  await expect(detail.locator(".prism-conversation-heading")).toHaveCount(1);
  await expect(detail.locator(".prism-conversation-heading").getByRole("button", { name: "Open as page", exact: true })).toBeVisible();
  await shot(page, "thread-desktop-light");
  await theme(page, false);
  await shot(page, "thread-desktop-dark");
  await theme(page, true);
  await detail.getByRole("button", { name: "Back to Mira Chen" }).click();
  await expect(timeline).toBeVisible();

  // Mail opens as mail; a meeting is a page of its own.
  await items.nth(1).click();
  await expect(detail.getByRole("heading", { name: "Saturday workshop agenda" })).toBeVisible();
  await detail.getByRole("button", { name: "Back to Mira Chen" }).click();
  await items.nth(2).click();
  expect(await page.evaluate(() => (window as any).prismInboxUI.getState().openTabs.some((tab: any) => tab.noteId === "meet-review"))).toBe(true);
});

test("in a thread your own messages are visibly yours and senders keep a colour of their own", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/inbox.html?visual");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  await page.getByRole("button", { name: /Workshop planning/ }).click();
  const mine = page.getByRole("article", { name: "Messages from You" });
  const theirs = page.getByRole("article", { name: "Messages from Mira Chen" });
  await expect(mine).toHaveAttribute("data-outgoing", "true");
  const bg = (article: typeof mine) => article.locator(".prism-message-bubble").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(mine)).not.toBe(await bg(theirs));
  // On the right, and labelled.
  const [a, b] = [(await mine.locator(".prism-message-bubble").first().boundingBox())!, (await theirs.locator(".prism-message-bubble").first().boundingBox())!];
  expect(a.x + a.width).toBeGreaterThan(b.x + b.width);
  await expect(mine.locator(".prism-sender")).toHaveText("You");
  // A sender's name carries that sender's tone (stable: derived from the sender id).
  const tone = (article: typeof mine) => article.locator(".prism-sender").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--sender-tone"));
  expect(await tone(theirs)).toMatch(/^#[0-9a-f]{6}$/);
  expect(await tone(mine)).toBe("");
  // One header, with the day named in full.
  await expect(page.locator(".prism-conversation-heading")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Conversation messages" }).getByRole("separator").first()).toHaveAttribute("aria-label", /\w+day, \w+ \d+, 20\d\d/);
  await shot(page, "thread-live-desktop-light");
  await theme(page, false);
  await shot(page, "thread-live-desktop-dark");
});

test("a person with no email or handle is explained, never an empty list", async ({ page }) => {
  await people(page);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("River");
  const row = page.getByRole("button", { name: /River Stone/ });
  await expect(row).toContainText("No email or handle on file");
  await row.click();
  const detail = page.getByRole("region", { name: "Selected conversation" });
  await expect(detail.getByRole("heading", { name: "River Stone has no email or handle on file" })).toBeVisible();
  await expect(detail).toContainText("never by name alone");
  await detail.getByRole("button", { name: "Add an email or handle" }).click();
  expect(await page.evaluate(() => (window as any).prismInboxUI.getState().openTabs.some((tab: any) => tab.noteId === "people:river"))).toBe(true);
  // Someone with an address but nothing matched is told that instead.
  await page.getByRole("textbox", { name: "Search inbox" }).fill("Sam");
  await page.getByRole("button", { name: /Sam Okafor/ }).click();
  await expect(detail.getByRole("heading", { name: "No conversations found for Sam Okafor" })).toBeVisible();
  // And a search that matches nobody says so.
  await page.getByRole("textbox", { name: "Search inbox" }).fill("zzz");
  await expect(page.getByText("No person matches “zzz”.")).toBeVisible();
});

test("a failed People read offers recovery", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?resolved");
  await page.evaluate(() => { (window as any).prismInboxFixture.denyPeople = true; });
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("People couldn’t be loaded");
  await page.evaluate(() => { (window as any).prismInboxFixture.denyPeople = false; });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: /Mira Chen/ })).toBeVisible();
});

for (const width of [390, 320])
  test(`phone ${width}: people → timeline → thread, one header, composer in view, back each step`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await people(page);
    await expect(page.getByRole("button", { name: /Mira Chen/ })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    if (width === 390) {
      await shot(page, "people-list-phone-light");
      await theme(page, false);
      await shot(page, "people-list-phone-dark");
      await theme(page, true);
    }
    await page.getByRole("button", { name: /Mira Chen/ }).click();
    // The list gives way to the timeline (list → detail), as in the mockup.
    await expect(page.getByRole("heading", { name: "Messages", exact: true })).not.toBeVisible();
    const timeline = page.getByRole("region", { name: "Conversations with Mira Chen" });
    await expect(timeline.locator(".prism-timeline-item")).toHaveCount(3);
    expect(await fitsWidth(page)).toBe(true);
    for (const target of await timeline.locator(".prism-timeline-item").all()) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (width === 390) await shot(page, "people-timeline-phone-light");
    await timeline.locator(".prism-timeline-item").first().click();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await expect(page.locator(".prism-conversation-heading")).toHaveCount(1);
    for (const name of ["Back to Mira Chen", "Open as page"]) {
      const b = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
    }
    expect(await fitsWidth(page)).toBe(true);
    if (width === 390) {
      await shot(page, "thread-phone-light");
      await theme(page, false);
      await shot(page, "thread-phone-dark");
      await theme(page, true);
    }
    await page.getByRole("button", { name: "Back to Mira Chen" }).click();
    await expect(timeline).toBeVisible();
    await page.getByRole("button", { name: "Back to people" }).click();
    await expect(page.getByRole("heading", { name: "Messages", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "People", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

test("the list shows an unread state and the triage view keeps one dense row per conversation", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?resolved");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  const mail = page.locator(".prism-message-row").filter({ hasText: "Saturday workshop agenda" });
  await expect(mail).toHaveAttribute("data-unread", "true");
  await expect(mail.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(mail.locator(".prism-row-name")).toHaveCSS("font-weight", "700");
  const chat = page.locator(".prism-message-row").filter({ hasText: "Workshop planning" });
  await expect(chat).not.toHaveAttribute("data-unread", "true");
  // The preview is the last message, without the transcript's timestamp.
  await expect(chat.locator(".prism-message-preview")).toHaveText("Mira Chen: I added the agenda for Saturday.");
  await expect(chat).toContainText("Telegram");
  await shot(page, "triage-desktop-light");
  await theme(page, false);
  await shot(page, "triage-desktop-dark");
});

// Before/after pictures of the same states (only with W16_SHOTS; asserts nothing about the design).
for (const [device, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const)
  test(`pictures: ${device}`, async ({ page }) => {
    test.skip(!SHOTS, "set W16_SHOTS to a directory");
    await page.setViewportSize(size);
    await page.goto("/e2e-fixtures/inbox.html?resolved");
    await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
    for (const light of [true, false]) {
      await theme(page, light);
      await shot(page, `state-list-${device}-${light ? "light" : "dark"}`);
    }
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.waitForTimeout(400);
    for (const light of [true, false]) {
      await theme(page, light);
      await shot(page, `state-people-${device}-${light ? "light" : "dark"}`);
    }
    await page.goto("/e2e-fixtures/inbox.html?visual");
    await page.locator(".prism-message-row").filter({ hasText: "Workshop planning" }).click();
    await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
    for (const light of [true, false]) {
      await theme(page, light);
      await shot(page, `state-thread-${device}-${light ? "light" : "dark"}`);
    }
  });
