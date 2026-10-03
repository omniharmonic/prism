/**
 * Suggest-only activation (NP-CO-12) against the REAL server: actual gateway,
 * collab socket (COLLAB_SUGGEST_ENFORCED on — the code default) and human
 * command endpoint, over the in-memory fake vault (real-server.ts).
 *
 * Proves: a suggest-level person cannot type into the shared document; their
 * suggestions and comments go through server-authored commands; the browser's
 * command revision matches the server's (revision parity, plain and rich docs);
 * a 409 keeps the draft and needs a fresh selection; a lost response is retried
 * with the SAME requestId and applied once; editors keep normal editing.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());

const editor = (page: Page) => page.locator(".tiptap").first();

async function open(page: Page, who: "sam" | "eve" | "owner", id: string) {
  await connect(page, page.context(), server, who);
  await page.goto(`/e2e-fixtures/collab-route.html?target=${id}`);
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(editor(page)).not.toHaveText("");
}

/** Double-click a word in the document (selects it in the read-only editor too).
 *  Waits for the layout to settle and checks the selection really is that word. */
async function selectWord(page: Page, word: string) {
  const locate = () =>
    page.evaluate((w) => {
      const root = document.querySelector(".tiptap")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      }
      return null;
    }, word);
  for (let attempt = 0; attempt < 5; attempt++) {
    const a = await locate();
    await page.waitForTimeout(250);
    const b = await locate();
    if (!a || !b || a.x !== b.x || a.y !== b.y) continue;
    await page.mouse.dblclick(b.x, b.y);
    if ((await page.evaluate(() => String(getSelection() ?? "").trim())) === word) return;
  }
  throw new Error(`could not select: ${word}`);
}

async function suggestReplace(page: Page, word: string, replacement: string) {
  await selectWord(page, word);
  await page.getByRole("button", { name: "Suggest an edit to the selection" }).click();
  const composer = page.getByRole("dialog", { name: "Suggest an edit" });
  await expect(composer.locator("blockquote")).toHaveText(word);
  await composer.getByLabel("Replacement text").fill(replacement);
  return composer;
}

test("suggest-only human cannot edit directly", async ({ page }) => {
  await open(page, "sam", "plan");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByText("Live · Suggesting")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("You can suggest changes");
  const before = await editor(page).innerText();
  await editor(page).click();
  await page.keyboard.type("RAW TYPING");
  await page.keyboard.press("Enter");
  expect(await editor(page).innerText()).toBe(before);
  await page.waitForTimeout(2500); // past the server's store debounce
  expect((await server.note("plan"))!.content).not.toContain("RAW");
  // No formatting controls for a suggest-only person.
  await selectWord(page, "gamma");
  await expect(page.getByRole("button", { name: "Bold selection" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suggest an edit to the selection" })).toBeVisible();
});

test("a suggestion goes through the command endpoint with a matching revision and appears for everyone", async ({ page, browser }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/commands")) posts.push(r.postData() ?? "");
  });
  await open(page, "sam", "plan");
  const composer = await suggestReplace(page, "beta", "delta");
  await expect(composer).toHaveAttribute("data-revision-parity", "match");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion sent for review." })).toBeVisible();
  await expect(page.locator('[data-suggestion="insert"]')).toHaveText("delta");
  await expect(page.locator('[data-suggestion="delete"]')).toHaveText("beta");
  expect(posts).toHaveLength(1);
  const sent = JSON.parse(posts[0]!);
  expect(Object.keys(sent).sort()).toEqual(["createdAt", "from", "kind", "quote", "requestId", "revision", "text", "to"]);
  expect(sent).toMatchObject({ kind: "suggest", quote: "beta", text: "delta" });
  await expect.poll(async () => (await server.note("plan"))!.content).toContain('data-suggestion="insert"');
  expect(String((await server.note("plan"))!.metadata?.prism_last_change)).toMatch(/^suggestion@/);
  expect(String((await server.note("plan"))!.metadata?.prism_last_writer)).toMatch(/^u_[0-9a-f]{16}$/);
  // An editor sees it live and can accept it.
  const editorPage = await browser.newPage();
  await open(editorPage, "eve", "plan");
  await expect(editorPage.locator('[data-suggestion="insert"]')).toHaveText("delta");
  await expect(editor(editorPage)).toHaveAttribute("contenteditable", "true");
  await editorPage.close();
});

test("revision parity holds on a rich document (headings, marks, lists, tasks, code, links)", async ({ page }) => {
  await open(page, "sam", "rich");
  const composer = await suggestReplace(page, "sources", "references");
  await expect(composer).toHaveAttribute("data-revision-parity", "match");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion sent for review." })).toBeVisible();
  await expect(page.locator('[data-suggestion="insert"]')).toHaveText("references");
});

test("a stale revision keeps the draft and asks for the passage again", async ({ page, browser }) => {
  await open(page, "sam", "plan");
  const composer = await suggestReplace(page, "Second", "Next");
  // Meanwhile an editor changes the page.
  const editorPage = await browser.newPage();
  await open(editorPage, "eve", "plan");
  await editor(editorPage).click();
  await editorPage.keyboard.press("End");
  await editorPage.keyboard.type(" More.");
  await expect(page.locator(".tiptap")).toContainText("More.");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(composer.getByRole("alert")).toContainText("The page changed while you were writing");
  await expect(composer.getByLabel("Replacement text")).toHaveValue("Next");
  await editorPage.close();
  // Re-select and resend: a NEW request, accepted.
  await selectWord(page, "Second");
  await composer.getByRole("button", { name: "Use current selection" }).click();
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion sent for review." })).toBeVisible();
});

test("a lost response is retried with the same requestId and applied once", async ({ page }) => {
  await open(page, "sam", "rich");
  const bodies: string[] = [];
  let first = true;
  await page.route(/\/api\/collab\/[^/]+\/commands/, async (route) => {
    bodies.push(route.request().postData() ?? "");
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}` });
    if (first) {
      first = false;
      return route.abort("connectionreset"); // applied on the server, response lost
    }
    await route.fulfill({ response });
  });
  const composer = await suggestReplace(page, "Second", "Another");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(composer.getByRole("alert")).toContainText("offline");
  await composer.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion sent for review." })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  await expect(page.locator('[data-suggestion="insert"]', { hasText: "Another" })).toHaveCount(1);
});

test("comments, replies and resolve go through commands for a suggest-only person", async ({ page }) => {
  await open(page, "sam", "notes");
  await selectWord(page, "Child");
  await page.getByRole("button", { name: "Comment on selection" }).click();
  const composer = page.getByRole("dialog", { name: "Comment on selection" });
  await composer.getByLabel("Comment").fill("Is gamma right?");
  await composer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Comment added." })).toBeVisible();
  await page.getByRole("button", { name: "Comments" }).click();
  await expect(page.getByText("Is gamma right?")).toBeVisible();
  await page.getByLabel("Reply").fill("Checking the source.");
  await page.getByLabel("Reply").press("Enter");
  await expect(page.getByText("Checking the source.")).toBeVisible();
  await page.getByRole("button", { name: "Resolve thread" }).click();
  await page.getByRole("button", { name: /Resolved/ }).click();
  await expect(page.getByText("Is gamma right?")).toBeVisible();
});
