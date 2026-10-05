import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * "Recovered text": the server owner's way to what a page held when a newer copy replaced
 * typing that was not saved (the text used to be reachable only through the API).
 * Routes are faked in the page (recovered-text.tsx); the server side is covered by
 * apps/server/test/collab-round6.test.ts and conversion-round5.test.ts.
 */
const fixture = "/e2e-fixtures/recovered-text.html";
type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
const calls = (page: Page) => page.evaluate(() => (window as unknown as { prismRecovered: { calls: Call[] } }).prismRecovered.calls);
const card = (page: Page) => page.getByRole("region", { name: "Recovered text", exact: true });

test("the owner sees what was kept (page name by their own read, date, size), views and copies it, and deletes it in two steps", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.goto(fixture);
  await expect(card(page).getByRole("heading", { name: "Recovered text" })).toBeVisible();
  const kept = card(page).getByRole("list", { name: "Recovered text" }).getByRole("listitem");
  await expect(kept).toHaveCount(2);
  await expect(kept.nth(0)).toContainText("Launch plan");
  await expect(kept.nth(0)).toContainText("61 characters");
  await expect(kept.nth(0)).toContainText("could not be merged");
  await expect(kept.nth(0)).toContainText("2026");
  // A page the owner can no longer read is named by its id, never guessed.
  await expect(kept.nth(1)).toContainText("Page gone");
  await expect(kept.nth(1)).toContainText("12k characters");
  // The list never fetches a body: only an explicit View does (the server audits each read).
  expect((await calls(page)).filter((c) => c.path.includes("/set-aside/"))).toEqual([]);
  // …and page NAMES come from the tree: no page is read (not its body, not anybody's private page) to show a title.
  expect((await calls(page)).filter((c) => c.path.startsWith("/api/notes"))).toEqual([]);
  expect((await calls(page)).some((c) => c.path === "/api/tree")).toBe(true);
  expect((await calls(page)).every((c) => c.headers["x-prism-vault"] === "primary")).toBe(true);

  await kept.nth(0).getByRole("button", { name: /^View/ }).click();
  const text = card(page).getByRole("region", { name: "Text of Launch plan as it was" });
  await expect(text).toContainText("The paragraph I was typing when the newer copy arrived.");
  expect((await calls(page)).filter((c) => c.method === "GET" && c.path === "/api/admin/collab/set-aside/7")).toHaveLength(1);
  await text.getByRole("button", { name: "Copy text" }).click();
  await expect(card(page).getByText("Copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("The paragraph I was typing");
  await kept.nth(0).getByRole("button", { name: "Close", exact: false }).click();
  await expect(text).toHaveCount(0);

  // Delete: nothing is sent by the first press.
  await kept.nth(0).getByRole("button", { name: /^Delete/ }).click();
  await expect(kept.nth(0)).toContainText("Delete this text for good?");
  expect((await calls(page)).filter((c) => c.method === "DELETE")).toEqual([]);
  await kept.nth(0).getByRole("button", { name: "Cancel" }).click();
  expect((await calls(page)).filter((c) => c.method === "DELETE")).toEqual([]);
  await kept.nth(0).getByRole("button", { name: /^Delete/ }).click();
  await kept.nth(0).getByRole("button", { name: "Delete for good" }).click();
  await expect(kept).toHaveCount(1);
  await expect(kept.nth(0)).toContainText("Page gone");
  const del = (await calls(page)).filter((c) => c.method === "DELETE");
  expect(del.map((c) => c.path)).toEqual(["/api/admin/collab/set-aside/7"]);
  expect(del[0]!.headers["content-type"]).toBe("application/json");

  const bad = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
  expect(bad.filter((v) => !v.startsWith("document-title") && !v.startsWith("html-has-lang"))).toEqual([]);
});

test("discarding needs the page's name typed — fixed when the form opens; an unnamed page needs the word DISCARD; force only for a page STILL listed as retrying", async ({ page }) => {
  await page.goto(fixture);
  const rows = card(page).getByRole("list", { name: "Pages with changes that are not saved" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const huge = rows.filter({ hasText: "Everything we know" });
  await expect(huge).toContainText("Cannot be saved as it is");
  await expect(huge).toContainText("too large or complex");
  await huge.getByRole("button", { name: /^Discard unsaved changes…/ }).click();
  const go = huge.getByRole("button", { name: "Discard changes" });
  await expect(go).toBeDisabled();
  const field = huge.getByRole("textbox");
  await field.fill("everything we know"); // not the name
  await expect(go).toBeDisabled();
  await field.press("Enter");
  expect((await calls(page)).filter((c) => c.method === "POST")).toEqual([]);
  await field.fill("Everything we know");
  await expect(go).toBeEnabled();
  await go.click();
  await expect(rows).toHaveCount(2);
  await expect(card(page).getByRole("status")).toContainText("were discarded");
  let posts = (await calls(page)).filter((c) => c.method === "POST");
  expect(posts.map((c) => [c.path, c.body])).toEqual([["/api/admin/collab/unsaved/huge/discard", { confirm: true }]]);
  // The list was asked again right before the discard was sent.
  const order = (await calls(page)).map((c) => `${c.method} ${c.path}`);
  const sent = order.lastIndexOf("POST /api/admin/collab/unsaved/huge/discard");
  expect(order.slice(sent - 2, sent)).toContain("GET /api/admin/collab/unsaved");

  // A page with no name of its own ("Untitled"): its name proves nothing — the word DISCARD is required.
  const blank = rows.filter({ hasText: "Untitled" });
  await blank.getByRole("button", { name: /^Discard unsaved changes…/ }).click();
  await expect(blank).toContainText("Type DISCARD to confirm");
  await blank.getByRole("textbox").fill("Untitled");
  await expect(blank.getByRole("button", { name: "Discard changes" })).toBeDisabled();
  await blank.getByRole("button", { name: "Cancel" }).click();

  // A page the server is still trying to save: said so, and discarded with force only while it is STILL listed so.
  const slow = rows.filter({ hasText: "Standup" });
  await expect(slow).toContainText("still trying to save");
  await slow.getByRole("button", { name: /^Discard anyway…/ }).click();
  await expect(slow).toContainText("has not given up");
  await slow.getByRole("textbox").fill("Standup");
  // Meanwhile the retry landed: the server no longer lists the page (and someone may be typing in it again).
  await page.evaluate(() => { const s = (window as any).prismRecovered.state; s.rows = s.rows.filter((r: any) => r.noteId !== "slow"); });
  await slow.getByRole("button", { name: "Discard changes" }).click();
  await expect(card(page).getByRole("status")).toContainText("has been saved in the meantime. Nothing was discarded.");
  posts = (await calls(page)).filter((c) => c.method === "POST");
  expect(posts, "no forced discard was sent on a stale list").toHaveLength(1);
  await expect(rows).toHaveCount(1);
});

test("a retrying page that is still retrying is discarded with force; while names are being looked up nothing can be discarded", async ({ page }) => {
  await page.goto(`${fixture}?slow-names`);
  const rows = card(page).getByRole("list", { name: "Pages with changes that are not saved" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  // Names not resolved yet: the rows show ids, and no discard form can be opened (what must be typed is not known).
  for (const b of await rows.getByRole("button", { name: /^Discard/ }).all()) await expect(b).toBeDisabled();
  await page.evaluate(() => { (window as any).prismRecovered.state.holdTree = false; });
  const slow = rows.filter({ hasText: "Standup" });
  await slow.getByRole("button", { name: /^Discard anyway…/ }).click();
  await slow.getByRole("textbox").fill("Standup");
  await slow.getByRole("button", { name: "Discard changes" }).click();
  await expect(rows).toHaveCount(2);
  const posts = (await calls(page)).filter((c) => c.method === "POST");
  expect(posts.map((c) => c.body)).toEqual([{ confirm: true, force: true }]);
});

test("anyone but the server owner gets nothing at all; an empty list says what would appear here", async ({ page }) => {
  await page.goto(`${fixture}?forbidden`);
  await expect(page.getByTestId("after")).toBeVisible();
  await expect.poll(async () => (await calls(page)).length).toBeGreaterThan(0);
  await expect(page.getByTestId("recovered-text")).toHaveCount(0);
  await expect(page.getByText("Recovered text")).toHaveCount(0);

  await page.goto(`${fixture}?empty`);
  await expect(card(page).getByTestId("recovered-empty")).toHaveText(/Nothing to recover\. When a newer copy of a page replaces typing that was not saved yet/);
  await expect(card(page).getByRole("list")).toHaveCount(0);
});

test("the document's \"replaced part of this page\" notice: the owner recovers the text in place — outside the live region — and everyone else is told who has it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?notice&owner`);
  const notice = page.getByTestId("collab-notice");
  await expect(notice).toContainText("Changes made elsewhere replaced part of this page.");
  expect(await calls(page)).toEqual([]); // nothing is asked until the owner wants it
  await notice.getByRole("button", { name: "Recover text" }).click();
  const panel = page.getByTestId("recover-panel");
  const kept = panel.getByRole("list", { name: "Recovered text" }).getByRole("listitem");
  await expect(kept).toHaveCount(1); // this page's only
  await expect(kept).toContainText("Launch plan");
  await kept.getByRole("button", { name: /^View/ }).click();
  await expect(panel.getByRole("region", { name: "Text of Launch plan as it was" })).toContainText("The paragraph I was typing");
  // The status paragraph holds the sentence and its buttons only: no list, no text block, no region inside it.
  expect(await notice.evaluate((p) => ({ tag: p.tagName, blocks: p.querySelectorAll("ul, ol, pre, div, section, form, h4, p").length, holdsPanel: !!p.querySelector("[data-testid=recover-panel]") }))).toEqual({ tag: "P", blocks: 0, holdsPanel: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto(`${fixture}?notice`);
  await expect(page.getByTestId("collab-notice")).toContainText("Ask the workspace owner — the text was kept.");
  await expect(page.getByRole("button", { name: "Recover text" })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);

  // Marked owner in the browser but refused by the server (a vault-role owner): the same sentence, no empty panel.
  await page.goto(`${fixture}?notice&owner&forbidden`);
  await page.getByRole("button", { name: "Recover text" }).click();
  await expect(page.getByTestId("recover-ask")).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover text" })).toHaveCount(0);
});
