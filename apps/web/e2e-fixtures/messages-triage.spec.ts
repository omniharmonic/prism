/**
 * Messages → category tags (fixture `inbox.html?triage`): ONE row of filter chips with counts in
 * sentence case, one compact chip per row, a stable order when ingest clears tags, `triage-failed`
 * shown as its own state with a way back to the classifier, and every status change as ONE write.
 */
import { test, expect, type Page } from "@playwright/test";
import { threadStatus, statusChange } from "../../../packages/core/src/lib/messages/triage";

const chips = (page: Page) => page.getByRole("group", { name: "Filter by category" }).getByRole("button");
const chip = (page: Page, name: string) => page.getByRole("group", { name: "Filter by category" }).getByRole("button", { name, exact: true });
const rows = (page: Page) => page.locator(".prism-message-row");
const writes = (page: Page) => page.evaluate(() => (window as any).prismInboxFixture.tagWrites);
const refetch = (page: Page) => page.evaluate(() => (window as any).prismInboxQuery.invalidateQueries({ queryKey: ["vault", "inbox"] }));

test("the classification model reads every tag it can meet", () => {
  expect(threadStatus(["triage-failed"])).toBe("triage-failed");
  expect(threadStatus(["triage-failed", "urgent"])).toBe("urgent");
  expect(threadStatus(["needs-triage"])).toBe("unclassified");
  expect(threadStatus(["triaged", "triage-failed"])).toBe("triaged");
  // One change clears every other classification tag, keeps the classifier's `triaged` marker.
  expect(statusChange(["action-required", "triaged", "triage-failed", "x"], "urgent")).toEqual({ add: ["urgent"], remove: ["action-required", "triage-failed"] });
  expect(statusChange(["urgent", "triaged"], "triaged")).toEqual({ add: [], remove: ["urgent"] });
});

test("one row of chips with counts, sentence case, and one category chip per row in recency order", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?triage");
  await expect(chips(page)).toHaveText([
    "All 8", "Urgent 1", "Action required 1", "Needs triage 2", "Couldn’t classify 1", "Informational 1", "Low priority 1", "Handled 1",
  ]);
  await expect(chip(page, "All 8")).toHaveAttribute("aria-pressed", "true");
  // Every row: exactly one chip, and the list is newest first (an ISO `lastMessageAt` sorts too).
  await expect(rows(page)).toHaveCount(8);
  await expect(page.locator(".prism-message-row .prism-status-chip")).toHaveCount(8);
  await expect(page.locator(".prism-message-row .prism-row-name")).toHaveText([
    "Grant deadline", "Budget question", "Garbled thread", "New chat", "Plain chat", "Newsletter", "Promo", "Done thing",
  ]);
  await expect(rows(page).filter({ hasText: "Garbled thread" }).locator(".prism-status-chip")).toHaveText("Couldn’t classify");
  await expect(rows(page).filter({ hasText: "New chat" }).locator(".prism-status-chip")).toHaveText("Needs triage");
  // Tone from tokens: the urgent chip is tinted, a quiet one is not.
  const bg = (name: string) => rows(page).filter({ hasText: name }).locator(".prism-status-chip").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg("Grant deadline")).not.toBe(await bg("Done thing"));
  // Filtering is a toggle with aria-pressed; choosing it again goes back to All.
  await chip(page, "Urgent 1").click();
  await expect(chip(page, "Urgent 1")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "All 8")).toHaveAttribute("aria-pressed", "false");
  await expect(rows(page)).toHaveCount(1);
  await chip(page, "Urgent 1").click();
  await expect(chip(page, "All 8")).toHaveAttribute("aria-pressed", "true");
  // Search narrows inside the chosen filter, and the counts follow the search.
  await chip(page, "Needs triage 2").click();
  await page.getByRole("textbox", { name: "Search inbox" }).fill("plain");
  await expect(chip(page, "Needs triage 1")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveText([/Plain chat/]);
});

test("rows don't jump when ingest clears a thread's tags under the open filter", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?triage");
  await chip(page, "Urgent 1").click();
  await page.evaluate(() => (window as any).prismInboxFixture.setTags("t-urgent", ["message-thread"]));
  await refetch(page);
  // Still listed, now wearing its new chip; the counts are already the truth.
  await expect(chip(page, "Needs triage 3")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator(".prism-status-chip")).toHaveText("Needs triage");
  // Choosing the filter again starts from the current tags.
  await chip(page, "All 8").click();
  await expect(page.getByRole("group", { name: "Filter by category" }).getByRole("button", { name: /^Urgent/ })).toHaveCount(0);
  // An emptied filter says so instead of showing a blank list.
  await chip(page, "Handled 1").click();
  await page.getByRole("textbox", { name: "Search inbox" }).fill("zzz");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("Nothing in “Handled” matches this search.")).toBeVisible();
});

test("a thread the classifier gave up on is shown as such and can be sent back in one write", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?triage");
  await chip(page, "Couldn’t classify 1").click();
  await expect(page.getByText("The classifier gave up on these")).toBeVisible();
  await rows(page).filter({ hasText: "Garbled thread" }).click();
  const status = page.getByRole("combobox", { name: "Thread status" });
  await expect(status).toHaveValue("triage-failed");
  await page.getByRole("button", { name: "send it back to be classified" }).click();
  await expect(status).toHaveValue("unclassified");
  expect(await writes(page)).toEqual([{ id: "t-failed", op: "change", add: [], remove: ["triage-failed"], member: false }]);
  // The list follows the confirmed tags (no full reload): the row stays put with its new chip.
  await expect(chip(page, "Needs triage 3")).toBeVisible();
  await expect(rows(page).filter({ hasText: "Garbled thread" }).locator(".prism-status-chip")).toHaveText("Needs triage");
});

test("a status change is ONE write (owner and member dialects), and a refused one rolls back", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?triage");
  await rows(page).filter({ hasText: "Budget question" }).click();
  const status = page.getByRole("combobox", { name: "Thread status" });
  await status.selectOption("urgent");
  await expect(chip(page, "Urgent 2")).toBeVisible();
  expect(await writes(page)).toEqual([{ id: "t-action", op: "change", add: ["urgent"], remove: ["action-required"], member: false }]);
  // A member's note (read with `_caps`): same single write, the gateway's member dialect.
  await rows(page).filter({ hasText: "New chat" }).click();
  await page.getByRole("combobox", { name: "Thread status" }).selectOption("informational");
  await expect(chip(page, "Informational 2")).toBeVisible();
  expect((await writes(page))[1]).toEqual({ id: "t-needs", op: "change", add: ["informational"], remove: ["needs-triage"], member: true });
  // Refused: the control goes back, nothing in the list moves.
  await page.evaluate(() => { (window as any).prismInboxFixture.failTagWrites = true; });
  await rows(page).filter({ hasText: "Promo" }).click();
  const promo = page.getByRole("combobox", { name: "Thread status" });
  await promo.selectOption("handled");
  await expect(page.getByRole("alert")).toContainText("not confirmed");
  await expect(promo).toHaveValue("low");
  await expect(chip(page, "Low priority 1")).toBeVisible();
});

test("a shell without changeTags still adds before it removes", async ({ page }) => {
  await page.goto("/e2e-fixtures/inbox.html?triage&legacy");
  await rows(page).filter({ hasText: "Budget question" }).click();
  await page.getByRole("combobox", { name: "Thread status" }).selectOption("low");
  await expect(chip(page, "Low priority 2")).toBeVisible();
  expect((await writes(page)).map((w: { op: string }) => w.op)).toEqual(["add", "remove"]);
});

for (const width of [390, 320])
  test(`phone ${width}: the chips are one sideways row and the page never scrolls sideways`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/e2e-fixtures/inbox.html?triage");
    const group = page.getByRole("group", { name: "Filter by category" });
    await expect(group).toBeVisible();
    const box = await group.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, wrap: getComputedStyle(el).flexWrap }));
    expect(box.wrap).toBe("nowrap");
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const light of [true, false]) {
      await page.evaluate((l) => document.documentElement.classList.toggle("light", l), light);
      await page.screenshot({ path: info.outputPath(`triage-chips-${width}-${light ? "light" : "dark"}.png`), animations: "disabled" });
    }
  });
