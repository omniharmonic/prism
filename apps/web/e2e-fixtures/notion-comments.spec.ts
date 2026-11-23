import { test, expect, type Page } from "@playwright/test";

/**
 * NP-CO-02 — page-level comments: a discussion at the top of the page, not
 * anchored to text, with the same thread actions. Two local Y.Docs stand in for
 * two clients of one live document. The server half (the `page-comment` command:
 * suggest required, strict schema, receipts, budgets) is apps/server
 * test/human-collab.test.ts.
 */
const url = (q = "") => `/e2e-fixtures/notion-comments.html${q}`;
const mine = (page: Page) => page.getByRole("main", { name: "Your view" }).getByRole("region", { name: "Page discussion" });
const theirs = (page: Page) => page.getByRole("main", { name: "Other person's view" }).getByRole("region", { name: "Page discussion" });
const threads = (page: Page) => page.evaluate(() => Object.values((window as any).prismDiscussion.threads()) as Array<Record<string, any>>);

test("page-level discussion", async ({ page }, info) => {
  await page.goto(url());
  // Quiet until used: one "Add comment" control under the title, no thread cards.
  await expect(mine(page).getByRole("button", { name: "Add comment" })).toBeVisible();
  await expect(mine(page).locator("[data-comment-id]")).toHaveCount(0);

  // Start a discussion about the page (no text selected anywhere).
  await mine(page).getByRole("button", { name: "Add comment" }).click();
  const field = mine(page).getByRole("textbox", { name: "Comment on this page" });
  await expect(field).toBeFocused();
  await field.fill("Should this page move to the handbook?");
  await page.keyboard.press("ControlOrMeta+Enter");
  const card = mine(page).locator("[data-comment-id]");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Should this page move to the handbook?");
  await expect(card).toContainText("You");
  // It is a page thread in the shared comments map: no quote, no anchor.
  const [thread] = await threads(page);
  expect(thread).toMatchObject({ page: true, quote: "", resolved: false });
  expect(thread!.comments).toHaveLength(1);
  // The other client sees it at once, and replies with the ordinary thread actions.
  const there = theirs(page).locator("[data-comment-id]");
  await expect(there).toContainText("Should this page move to the handbook?");
  await there.getByRole("textbox", { name: "Reply" }).fill("Yes — after the review.");
  await page.keyboard.press("Enter");
  await expect(card).toContainText("Yes — after the review.");
  await expect(card).toContainText("Mira");
  await page.screenshot({ path: info.outputPath("page-discussion.png") });

  // It is also listed with every other thread, labelled as a page comment.
  const sidebar = page.getByRole("complementary", { name: "Comments sidebar" });
  await expect(sidebar).toContainText("Page comment");
  await expect(sidebar).toContainText("Should this page move to the handbook?");
  // An anchored thread stays out of the page discussion.
  await page.evaluate(() => (window as any).prismDiscussion.seedAnchored());
  await expect(sidebar).toContainText("the spring launch");
  await expect(mine(page).locator("[data-comment-id]")).toHaveCount(1);

  // Resolve → it leaves the open discussion; "Show 1 resolved" brings it back; Reopen; Delete.
  await card.getByRole("button", { name: "Resolve thread" }).click();
  await expect(mine(page).locator("[data-comment-id]")).toHaveCount(0);
  await expect(there).toHaveCount(0);
  await mine(page).getByRole("button", { name: "Show 1 resolved" }).click();
  await mine(page).locator("[data-comment-id]").getByRole("button", { name: "Reopen" }).click();
  await expect(mine(page).getByRole("button", { name: /resolved/ })).toHaveCount(0);
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "Delete thread" }).click();
  await card.getByRole("button", { name: "Delete?" }).click();
  await expect(mine(page).locator("[data-comment-id]")).toHaveCount(0);
  expect((await threads(page)).filter((t) => t.page)).toHaveLength(0);
  // A second thread can be started while others exist; Esc cancels a draft without writing.
  await mine(page).getByRole("button", { name: "Add comment" }).click();
  await field.fill("never sent");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  expect((await threads(page)).filter((t) => t.page)).toHaveLength(0);
});

test("page-level discussion: suggest-level people go through the command endpoint; a refusal keeps the draft", async ({ page }) => {
  await page.goto(url("?level=suggest"));
  await mine(page).getByRole("button", { name: "Add comment" }).click();
  const field = mine(page).getByRole("textbox", { name: "Comment on this page" });
  await field.fill("From a suggester");
  // The server refuses once: the draft and the composer stay, with the server's words.
  await page.evaluate(() => { (window as any).prismDiscussion.failNext = "The document or its comments changed. Your draft is kept."; });
  await mine(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(mine(page).getByRole("alert")).toHaveText("The document or its comments changed. Your draft is kept.");
  await expect(field).toHaveValue("From a suggester");
  expect((await threads(page))).toHaveLength(0);
  // Sent again: ONE command, text only — the client never writes the shared doc itself.
  await mine(page).getByRole("button", { name: "Comment", exact: true }).click();
  const card = mine(page).locator("[data-comment-id]");
  await expect(card).toContainText("From a suggester");
  const commands = await page.evaluate(() => (window as any).prismDiscussion.commands as Array<Record<string, unknown>>);
  expect(commands).toEqual([{ kind: "page-comment", text: "From a suggester" }, { kind: "page-comment", text: "From a suggester" }]);
  // Reply and resolve are commands too.
  await card.getByRole("textbox", { name: "Reply" }).fill("one more");
  await page.keyboard.press("Enter");
  await expect(card).toContainText("one more");
  await card.getByRole("button", { name: "Resolve thread" }).click();
  await expect(mine(page).locator("[data-comment-id]")).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).prismDiscussion.commands as Array<{ kind: string }>)).map((c) => c.kind)).toEqual(["page-comment", "page-comment", "reply", "resolve"]);
});

test("page-level discussion: view and comment levels can read it but get no composer; phone and dark fit", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("?level=view&dark"));
  // Nothing to show and nothing to do → nothing rendered.
  await expect(mine(page)).toHaveCount(0);
  // The other person starts one: it appears read-only here.
  await theirs(page).getByRole("button", { name: "Add comment" }).click();
  await theirs(page).getByRole("textbox", { name: "Comment on this page" }).fill("Visible to readers");
  await theirs(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(mine(page).locator("[data-comment-id]")).toContainText("Visible to readers");
  await expect(mine(page).getByRole("button", { name: /Add/ })).toHaveCount(0);
  await expect(mine(page).getByRole("textbox")).toHaveCount(0);
  await expect(mine(page).getByRole("button", { name: "Resolve thread" })).toHaveCount(0);
  expect(await theirs(page).getByRole("button", { name: "Add a page comment" }).evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath("page-discussion-phone-dark.png") });
});
