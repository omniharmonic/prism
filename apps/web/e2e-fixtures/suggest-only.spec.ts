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

// ── the merged editor (waves 2A/2B/2C/2E) gives a suggest-only person no raw-write path ──
const WRITE_OK = /^\/api\/(collab\/[^/]+\/commands|notifications\/|me\/preferences|push\/)/;
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" || r.method() === "HEAD" || !/^\/(api|acl)(\/|$)/.test(u.pathname) || WRITE_OK.test(u.pathname)) return;
    writes.push(`${r.method()} ${u.pathname}`);
  });
  return writes;
}
const dropFile = (page: Page, type: string) =>
  page.evaluate((type) => {
    const target = document.querySelector(".tiptap")!;
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "drop.png", { type: "image/png" }));
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent(type === "paste" ? "dragover" : type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 20, clientY: box.top + 10 }));
    if (type === "paste") target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, type);

test("the merged editor offers a suggest-only person nothing that writes the document directly", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const writes = watchWrites(page);
  await open(page, "sam", "plan");
  const stored = (await server.note("plan"))!;
  const before = await editor(page).innerText();

  // Title, icon, cover (2B) and the property bar (2C) are display-only.
  await expect(page.getByRole("heading", { name: /^Rename / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /cover/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /icon/i })).toHaveCount(0);
  const props = page.getByRole("group", { name: "Page properties" });
  // (Property values are written over REST with their own `edit` check; here: no editing controls.)
  await expect(props.getByRole("button", { name: /add (a )?property/i })).toHaveCount(0);
  await expect(props.locator("input:not([disabled]):not([type=hidden]), select:not([disabled]), [contenteditable=true]")).toHaveCount(0);

  // `@` mentions and the `/` menu (2A, incl. inline database insert) need an editable body.
  await editor(page).click();
  for (const key of ["@", "/"]) {
    await page.keyboard.type(key);
    await page.waitForTimeout(150);
    await expect(page.getByRole("listbox")).toHaveCount(0);
  }

  // Block handles (2E): hovering a block shows no gutter.
  await editor(page).locator("p").first().hover();
  await expect(page.getByRole("button", { name: "Insert block below" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /block actions/i })).toHaveCount(0);

  // Find (wave 3): ⌘F works in the read-only body — find only, Replace never offered.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("search", { name: "Find in note" });
  await expect(find).toBeVisible();
  await find.getByLabel("Find in note").fill("gamma");
  await expect(find.locator(".prism-find-count")).toHaveText("1 / 1");
  await expect(editor(page).locator(".prism-search-match").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+f");
  await page.waitForTimeout(200);
  await expect(page.getByLabel("Replace with")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Show replace|Replace|Replace all)$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(find).toHaveCount(0);

  // Files: a dropped or pasted image is neither uploaded nor inserted.
  await dropFile(page, "drop");
  await dropFile(page, "paste");
  await expect(editor(page).locator("img[src]:not(.ProseMirror-separator), figure, .prism-attachment")).toHaveCount(0);

  // The suggestion path is still there, and nothing above wrote anything.
  await selectWord(page, "gamma");
  await expect(page.getByRole("button", { name: "Suggest an edit to the selection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bold selection" })).toHaveCount(0);
  await page.waitForTimeout(2500); // past the server's store debounce
  expect(await editor(page).innerText()).toBe(before);
  expect(writes).toEqual([]);
  const after = (await server.note("plan"))!;
  expect(after.content).toBe(stored.content);
  expect(after.metadata).toEqual(stored.metadata);
});

test("a suggest-only person gets no empty-page starters and no phone editing toolbar", async ({ browser }) => {
  // Empty page: the starters (2E: templates, import, "Ask AI to draft") would write the body.
  const desk = await browser.newContext();
  const page = await desk.newPage();
  const writes = watchWrites(page);
  await connect(page, desk, server, "sam");
  await page.goto("/e2e-fixtures/collab-route.html?target=blank");
  await expect(page.getByText("Live · Suggesting")).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("group", { name: "Start this page" })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await desk.close();

  // Phone: a touch device shows the keyboard toolbar only for an editable body.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mobile = await phone.newPage();
  const phoneWrites = watchWrites(mobile);
  await connect(mobile, phone, server, "sam");
  await mobile.goto("/e2e-fixtures/collab-route.html?target=plan");
  await expect(mobile.getByText(/Suggesting/)).toBeVisible();
  await editor(mobile).tap();
  await expect(mobile.getByRole("toolbar", { name: "Editing toolbar" })).toHaveCount(0);
  await expect(mobile.getByRole("button", { name: /block actions/i })).toHaveCount(0);
  await expect(editor(mobile)).toHaveAttribute("contenteditable", "false");
  await mobile.waitForTimeout(500);
  expect([...writes, ...phoneWrites]).toEqual([]);
  await phone.close();
});

test("in the workspace itself: Shared with me opens the LIVE suggest-only editor; nothing typed reaches the server, a suggestion goes through a command", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = watchWrites(page);
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/commands")) posts.push(r.postData() ?? ""); });
  await connect(page, page.context(), server, "sam");
  await page.goto("/e2e-fixtures/collab-route.html?app");
  const shared = page.getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("button", { name: /Plan/ })).toBeVisible();
  // A guest (no workspace role): none of the workspace's own sections.
  await expect(page.getByRole("region", { name: "Pages", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New page", exact: true })).toHaveCount(0);
  await shared.getByRole("button", { name: /Plan/ }).click();
  await expect(editor(page)).toContainText("Alpha");
  // Wave 3: a PLAIN suggest share stays in the live session inside the workspace too
  // (Canvas routes only governance review to the propose draft). The socket is
  // read-only server-side; the body is not editable; no local draft exists.
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: /Submit for review/ })).toHaveCount(0);
  const before = await editor(page).innerText();
  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" RAW TYPING");
  expect(await editor(page).innerText()).toBe(before);
  await expect(page.getByRole("heading", { name: /^Rename / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /cover/i })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Start this page" })).toHaveCount(0);
  // ⌘F finds in the read-only live body (find only).
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("search", { name: "Find in note" });
  await expect(find).toBeVisible();
  await find.getByLabel("Find in note").fill("Alpha");
  await expect(find.locator(".prism-find-count")).toHaveText(/^1 \/ \d+$/);
  await expect(page.getByLabel("Replace with")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The suggestion path: a server-authored command, never a raw write.
  const composer = await suggestReplace(page, "Alpha", "Omega");
  await composer.getByRole("button", { name: "Suggest", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion sent for review." })).toBeVisible();
  expect(posts).toHaveLength(1);
  await page.waitForTimeout(3000); // past autosave and the server's store debounce
  expect(writes).toEqual([]);
  expect((await server.note("plan"))!.content).not.toContain("RAW");
  await expect.poll(async () => (await server.note("plan"))!.content).toContain("Omega");
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-benjaminlife-dev-prism/94600911-66b9-4b8d-b802-fc8f8fe9305f/scratchpad/w3-gaps/suggest-live-workspace.png" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
