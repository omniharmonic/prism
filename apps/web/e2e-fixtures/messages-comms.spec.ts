/**
 * Messages over the Comms API (Comms sprint Task 6, D19 stages 1–2: Prism's look, Comms'
 * behaviour). Fixture `inbox.html?comms`: a fake `vault.comms` (inbox-comms-data.ts) over the
 * resolved vault notes. Optional screenshots: COMMS_SHOTS=<dir>.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.COMMS_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const light of [true, false]) {
    await page.evaluate((on) => document.documentElement.classList.toggle("light", on), light);
    await page.screenshot({ path: `${SHOTS}/${name}-${light ? "light" : "dark"}.png`, animations: "disabled" });
  }
};
/** Open Messages over Comms and choose "All" (the view opens on Needs attention, like Prism's). */
const open = async (page: Page, extra = "", all = true) => {
  await page.goto(`/e2e-fixtures/inbox.html?comms${extra}`);
  if (all) await page.getByRole("group", { name: "Filter by category" }).getByRole("button", { name: "All", exact: true }).click();
};
const list = (page: Page) => page.getByRole("region", { name: "Conversation list" }).or(page.locator(".prism-messages-list"));
const row = (page: Page, id: string) => page.locator(`.prism-messages-list [data-thread-id="${id}"]`);
const queries = (page: Page) => page.evaluate(() => (window as any).prismCommsFixture.queries as Array<Record<string, unknown>>);
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("opens on Needs attention (Prism's default); All is one tap away", async ({ page }) => {
  await open(page, "", false);
  const chips = page.getByRole("group", { name: "Filter by category" });
  await expect(chips.getByRole("button", { name: /^Needs attention/ })).toHaveAttribute("aria-pressed", "true");
  await expect(list(page).locator(".prism-message-row")).toHaveCount(2);
  expect((await queries(page)).at(-1)).toMatchObject({ attention: true });
  await chips.getByRole("button", { name: "All", exact: true }).click();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(4);
});

test("the list is /api/comms/threads: real names, previews, pinned first, the inbox folder", async ({ page }) => {
  await open(page);
  const rows = list(page).locator(".prism-message-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Workshop planning"); // pinned
  await expect(rows.nth(0)).toContainText("Mira: Here is the venue");
  await expect(rows.nth(0).getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(rows.nth(0)).toContainText("Action required");
  await expect(row(page, "th_river")).toContainText("You: Great, see you then.");
  await expect(row(page, "th_river").getByLabel("Muted")).toBeVisible();
  // Low-priority and unknown-sender threads are in their own folders, not the inbox.
  await expect(page.getByText("Weekly deals")).toHaveCount(0);
  await expect(page.getByText("4 conversations")).toBeVisible();
  await shot(page, "comms-list");
});

test("folders, several statuses at once, attention, networks, unread — each is a server filter", async ({ page }) => {
  await open(page);
  await page.getByRole("group", { name: "Folders" }).getByRole("button", { name: "Low priority" }).click();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(1);
  await expect(page.getByText("Weekly deals")).toBeVisible();
  await page.getByRole("group", { name: "Folders" }).getByRole("button", { name: "Inbox" }).click();
  const chips = page.getByRole("group", { name: "Filter by category" });
  await chips.getByRole("button", { name: /^Urgent/ }).click();
  await chips.getByRole("button", { name: /^Social/ }).click();
  await expect(chips.getByRole("button", { name: /^Urgent/ })).toHaveAttribute("aria-pressed", "true");
  await expect(chips.getByRole("button", { name: /^Social/ })).toHaveAttribute("aria-pressed", "true");
  await expect(list(page).locator(".prism-message-row")).toHaveCount(2);
  await expect(row(page, "th_imsg")).toBeVisible();
  await expect(row(page, "th_river")).toBeVisible();
  expect((await queries(page)).at(-1)).toMatchObject({ folder: "inbox", statuses: ["urgent", "social"] });
  await chips.getByRole("button", { name: "All", exact: true }).click();
  await chips.getByRole("button", { name: /^Needs attention/ }).click();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(2); // urgent + action required
  expect((await queries(page)).at(-1)).toMatchObject({ attention: true, statuses: [] });
  await chips.getByRole("button", { name: "All", exact: true }).click();
  const nets = page.getByRole("group", { name: "Filter by network" });
  await nets.getByRole("button", { name: "Signal" }).click();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(1);
  await expect(row(page, "th_direct")).toBeVisible();
  await nets.getByRole("button", { name: "Signal" }).click();
  await nets.getByRole("button", { name: "Unread" }).click();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(2);
  expect((await queries(page)).at(-1)).toMatchObject({ unread: true, networks: [] });
});

test("a conversation renders from /threads/:id/messages: runs, a 60-minute time header, media, reactions, previews, replies", async ({ page }) => {
  await open(page);
  await row(page, "th_group").click();
  const detail = page.getByRole("region", { name: "Conversation messages" });
  await expect(page.getByRole("heading", { name: "Workshop planning" })).toBeVisible();
  // Two of Mira's messages two minutes apart are ONE run (one byline), the tail on the last.
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  const miraRun = detail.getByRole("article", { name: "Messages from Mira Chen" }).first();
  await expect(miraRun.locator(".prism-comms-bubble")).toHaveCount(2);
  await expect(miraRun.locator(".prism-comms-bubble").nth(1)).toHaveAttribute("data-tail", "true");
  await expect(miraRun.locator(".prism-comms-bubble").nth(0)).not.toHaveAttribute("data-tail", "true");
  // More than 60 minutes of quiet → a new run with a time header, even from the same sender (75 min
  // after "Draft is here"; and 3 h after the join notice).
  await expect(detail.locator(".prism-comms-time-header")).toHaveCount(2);
  await expect(detail.getByRole("article", { name: "Messages from You" })).toHaveCount(2);
  // A new day → a day separator; a system notice stands on its own.
  await expect(detail.getByRole("separator")).toHaveCount(2);
  await expect(detail.getByText("Mira Chen joined")).toBeVisible();
  await expect(detail.getByRole("list", { name: "Reactions" }).getByRole("listitem", { name: /👍 2, including you/ })).toBeVisible();
  await expect(detail.getByRole("link", { name: /Saturday workshop agenda/ })).toHaveAttribute("href", "https://example.org/agenda");
  await expect(detail.getByRole("img", { name: "venue.jpg" })).toBeVisible();
  await expect(detail.getByLabel("Voice message").first()).toBeVisible();
  await expect(detail.getByText("In reply to")).toBeAttached();
  await expect(detail.getByText("Read", { exact: true })).toBeVisible();
  // The vault note still drives status and the reply box; its transcript is the archive.
  await expect(page.getByRole("combobox", { name: "Thread status" })).toHaveValue("action-required");
  await page.getByRole("button", { name: "View archived transcript" }).click();
  await expect(page.getByText("Archived transcript")).toBeVisible();
  await expect(page.getByText("I added the agenda for Saturday.")).toBeVisible();
  await page.getByRole("button", { name: "Back to the conversation" }).click();
  await expect(detail.locator(".prism-comms-bubble").first()).toBeVisible();
  await shot(page, "comms-thread");
});

test("a DM opens its contact page with shared chats; Show in Messages filters the list by person", async ({ page }) => {
  await open(page);
  await row(page, "th_direct").click();
  await page.getByRole("button", { name: "Contact" }).click();
  await expect(page.getByRole("heading", { name: "Rowan Ellis" })).toBeVisible();
  await expect(page.getByText("+15550002222")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Shared chats/ })).toContainText("2");
  await shot(page, "comms-contact");
  await page.getByRole("button", { name: "Show in Messages" }).click();
  await expect(page.getByRole("button", { name: /Showing conversations with Rowan Ellis/ })).toBeVisible();
  await expect(list(page).locator(".prism-message-row")).toHaveCount(2);
  expect((await queries(page)).at(-1)).toMatchObject({ person: "rowan" });
  expect((await queries(page)).at(-1)).not.toHaveProperty("folder");
  // Back from the contact page returns to the conversation it was opened from.
  await row(page, "th_direct").click();
  await page.getByRole("button", { name: "Contact" }).click();
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await expect(page.getByRole("heading", { name: "Rowan Ellis" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Thread status" })).toBeVisible();
});

test("a Comms conversation with no vault note (iMessage) opens read-only; group bylines open contacts", async ({ page }) => {
  await open(page);
  await row(page, "th_imsg").click();
  await expect(page.getByRole("heading", { name: "Sam Okafor" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Conversation messages" }).getByText("Can you call me back?")).toBeVisible();
  await expect(page.getByText("Replying to this conversation is available in the Comms app.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /message/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to messages" }).click();
  await row(page, "th_group").click();
  await page.getByRole("region", { name: "Conversation messages" }).getByRole("button", { name: "Rowan Ellis" }).first().click();
  await expect(page.getByRole("heading", { name: "Rowan Ellis" })).toBeVisible();
  await expect(page.getByText("Contact", { exact: true })).toBeVisible();
});

test("search and the next page are server reads", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Search inbox" }).fill("river");
  await expect(list(page).locator(".prism-message-row")).toHaveCount(1);
  expect((await queries(page)).at(-1)).toMatchObject({ q: "river" });
});

test("Email keeps the vault's email notes; People keeps the server's people index", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await expect(page.getByText("Saturday Workshop Agenda")).toBeVisible();
  await page.getByText("Saturday Workshop Agenda").click();
  await expect(page.getByRole("heading", { name: /Saturday workshop agenda/ })).toBeVisible();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByRole("list", { name: "People with conversations" }).getByRole("button")).toHaveCount(2);
});

test("Comms refused (off, not the owner, another vault) → the vault notes view, unchanged", async ({ page }) => {
  for (const status of [403, 404, 409]) {
    await open(page, `&comms-refuse=${status}`, false);
    await expect(page.getByRole("button", { name: "Triage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Platforms" })).toBeVisible();
    await expect(page.locator("[data-source=comms]")).toHaveCount(0);
  }
});

test("offline or a 5xx → the saved vault conversations with a notice, never an empty screen; Try again switches back", async ({ page }) => {
  for (const status of [503, 0]) {
    // 0 = no HTTP status at all (offline / connection reset)
    await page.goto(`/e2e-fixtures/inbox.html?comms&comms-refuse=${status === 0 ? "-1" : status}`);
    await expect(page.locator("[data-source=comms]")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Live conversations can’t be reached" })).toBeVisible();
    await expect(page.locator(".prism-message-row").first()).toBeVisible(); // the saved conversations
  }
  await page.evaluate(() => { (window as any).prismCommsFixture.refuse = 0; });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-source=comms]")).toBeVisible();
});

test("a 429 keeps Comms and offers Try again (not a switch of source)", async ({ page }) => {
  await open(page, "&comms-refuse=429", false);
  await expect(page.locator("[data-source=comms]")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("couldn’t be loaded");
});

test("polling re-reads only the newest page, never the older pages already loaded", async ({ page }) => {
  await open(page);
  await row(page, "th_group").click();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Mira Chen joined")).toBeVisible();
  const reads = () => page.evaluate(() => (window as any).prismCommsFixture.messageReads as Array<{ id: string; before?: string }>);
  const before = (await reads()).length;
  await page.evaluate(async () => {
    const q = (window as any).prismInboxQuery;
    await q.refetchQueries({ queryKey: ["comms", "messages-head"] });
    await q.refetchQueries({ queryKey: ["comms", "messages"], stale: true });
  });
  const after = (await reads()).slice(before);
  expect(after).toEqual([{ id: "th_group" }]);
});

test("native shell: audio and video are not fetched until Play is pressed (no poster URL)", async ({ page }) => {
  await open(page, "&native-media");
  await row(page, "th_direct").click();
  const detail = page.getByRole("region", { name: "Conversation messages" });
  await expect(detail.getByRole("button", { name: /Play hall\.mp4/ })).toBeVisible();
  await expect(detail.locator("video, audio")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to messages" }).click();
  await row(page, "th_group").click();
  await expect(page.getByRole("region", { name: "Conversation messages" }).getByRole("button", { name: /Play voice message/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismCommsFixture.mediaLoads)).toEqual([]);
  await page.getByRole("region", { name: "Conversation messages" }).getByRole("button", { name: /Play voice message/ }).click();
  await expect(page.getByRole("region", { name: "Conversation messages" }).locator("audio")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).prismCommsFixture.mediaLoads)).toEqual(["tok-voice"]);
});

test("PWA: video keeps preload=none with its poster", async ({ page }) => {
  await open(page);
  await row(page, "th_direct").click();
  const video = page.getByRole("region", { name: "Conversation messages" }).locator("video");
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video).toHaveAttribute("poster", /^data:/);
});

test("a conversation opened from People (no hint) is looked up by note id and read from Comms", async ({ page }) => {
  await open(page);
  // Keep the group out of the loaded list, so the conversation has no hint and must be looked up.
  await page.getByRole("group", { name: "Filter by network" }).getByRole("button", { name: "Signal" }).click();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("list", { name: "People with conversations" }).getByRole("button", { name: /Mira Chen/ }).click();
  await page.getByRole("button", { name: /Workshop planning/ }).first().click();
  await expect(page.getByRole("region", { name: "Conversation messages" }).locator(".prism-comms-bubble").first()).toBeVisible();
  expect((await queries(page)).some((q) => q.note === "group")).toBe(true);
});

test("a failed note lookup shows the saved transcript WITH a notice, and is asked again next time", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).prismCommsFixture.refuseNoteLookup = 503; });
  // Keep the group out of the loaded list, so the conversation has no hint and must be looked up.
  await page.getByRole("group", { name: "Filter by network" }).getByRole("button", { name: "Signal" }).click();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("list", { name: "People with conversations" }).getByRole("button", { name: /Mira Chen/ }).click();
  await page.getByRole("button", { name: /Workshop planning/ }).first().click();
  await expect(page.getByText("The live conversation can’t be reached right now")).toBeVisible();
  await expect(page.getByText("Saved conversation")).toBeVisible();
  await page.evaluate(() => { (window as any).prismCommsFixture.refuseNoteLookup = 0; });
  await page.getByRole("button", { name: /Back to Mira Chen/ }).click();
  await page.getByRole("button", { name: /Workshop planning/ }).first().click();
  await expect(page.getByRole("region", { name: "Conversation messages" }).locator(".prism-comms-bubble").first()).toBeVisible();
});

test("with Comms refused, a conversation from People uses the saved transcript and makes no comms lookup", async ({ page }) => {
  await open(page, "&comms-refuse=403", false);
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("list", { name: "People with conversations" }).getByRole("button", { name: /Mira Chen/ }).click();
  await page.getByRole("button", { name: /Workshop planning/ }).first().click();
  await expect(page.getByText("Saved conversation")).toBeVisible();
  await expect(page.getByText("The live conversation can’t be reached")).toHaveCount(0);
  expect((await queries(page)).some((q) => q.note)).toBe(false);
});

test("an open conversation stays put when a filter drops it from the list", async ({ page }) => {
  await open(page);
  await row(page, "th_group").click();
  await expect(page.getByRole("region", { name: "Conversation messages" }).locator(".prism-comms-bubble").first()).toBeVisible();
  await page.getByRole("region", { name: "Conversation messages" }).evaluate((el) => { el.setAttribute("data-marker", "same"); });
  await page.getByRole("group", { name: "Filter by network" }).getByRole("button", { name: "Signal" }).click();
  await expect(row(page, "th_group")).toHaveCount(0);
  await expect(page.locator("[data-marker=same]")).toHaveCount(1);
  await expect(page.getByText("Opening conversation…")).toHaveCount(0);
});

test("phone: list, then a conversation, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(await fitsWidth(page)).toBe(true);
  await row(page, "th_group").click();
  await expect(page.getByRole("heading", { name: "Workshop planning" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await shot(page, "comms-phone-thread");
});
