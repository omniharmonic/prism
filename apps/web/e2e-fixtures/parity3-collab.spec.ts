/**
 * Parity pass 3 (slice G) — clauses that need the REAL server (gateway, collab socket,
 * command endpoint and Prism MCP over the in-memory fake vault; real-server.ts):
 *
 *   NP-CO-10  "remote caret name tags": several collaborators at once
 *   NP-PG-08  per-page style on a LIVE document, honoured on another device
 *   NP-CO-14  a guest's ⌘K, @ menu, Inbox and database see only what was shared
 *   NP-CO-01  phone: the comment thread opens in a sheet over the page
 *   NP-AI-02  an agent's edits arrive as suggestions: previous / next, accept, dismiss
 *   NP-PG-03  a title edit reaching another client that has the page open
 */
import { test, expect, type Page, type Browser, type BrowserContext } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => server?.stop());
test.setTimeout(90_000); // several browser profiles against one real server

type Who = "owner" | "sam" | "eve" | "gina";
const editor = (page: Page) => page.locator(".tiptap").first();

/** A separate browser profile per person (a "device"). */
async function device(browser: Browser, who: Who, url: string, viewport = { width: 1280, height: 860 }): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await connect(page, context, server, who);
  await page.goto(url);
  return { page, context };
}
const share = (id: string) => `/e2e-fixtures/collab-route.html?target=${id}`;
const inApp = (id: string) => `/e2e-fixtures/collab-route.html?page=${id}`;
async function live(page: Page) {
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(editor(page)).not.toHaveText("");
}
/** A write credential for Prism's own MCP endpoint, minted by the signed-in person (Settings → "Connect your agent"). */
async function mintAgentToken(page: Page): Promise<string> {
  const minted = await page.evaluate(async () => {
    const r = await fetch("/auth/pats", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "parity agent", scope: "write", expiresInDays: 1 }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  expect(minted.status, JSON.stringify(minted.body)).toBeLessThan(300);
  expect(String(minted.body.token)).toMatch(/^pp_/);
  return minted.body.token as string;
}
let rpc = 0;
/** One Prism MCP tool call, as an agent makes it (stateless Streamable HTTP). */
async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2026-07-28", "MCP-Method": "tools/call", "MCP-Name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
  });
  const text = await r.text();
  expect(r.status, text).toBe(200);
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(data ? data.slice(6) : text) as { result?: { isError?: boolean; structuredContent?: unknown }; error?: unknown };
  expect(msg.error, text).toBeUndefined();
  expect(msg.result?.isError, text).toBeFalsy();
  return msg.result!.structuredContent as Record<string, unknown>;
}
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

/** NP-CO-10 · "Live carets with name tags for every collaborator in collab documents". */
test("remote caret name tags", async ({ browser }) => {
  const owner = await device(browser, "owner", share("plan"));
  const eve = await device(browser, "eve", share("plan"));
  const sam = await device(browser, "sam", share("plan")); // reads along (suggest level)
  for (const d of [owner, eve, sam]) await live(d.page);
  // Two people place their carets in different paragraphs.
  await owner.page.getByText("Alpha beta gamma").click();
  await eve.page.getByText("Second paragraph here.").click();

  // The third person sees BOTH carets, each with its owner's name, each in its own paragraph.
  const carets = sam.page.locator(".collaboration-carets__caret");
  await expect(carets).toHaveCount(2);
  const tag = (name: string) => sam.page.locator(".collaboration-carets__caret", { hasText: name });
  for (const name of ["Olive Owner", "Eve Editor"]) {
    await expect(tag(name)).toHaveCount(1);
    await expect(tag(name).locator(".collaboration-carets__label")).toHaveText(name);
  }
  expect(await tag("Olive Owner").evaluate((el) => el.closest("p")?.textContent ?? "")).toContain("Alpha beta gamma");
  expect(await tag("Eve Editor").evaluate((el) => el.closest("p")?.textContent ?? "")).toContain("Second paragraph here.");
  // Each caret and its name tag are drawn in that person's own, stable colour — and the two differ.
  const colourOf = (name: string) => tag(name).evaluate((el) => ({ caret: getComputedStyle(el).borderLeftColor, label: getComputedStyle(el.querySelector(".collaboration-carets__label")!).backgroundColor }));
  const [o, e] = [await colourOf("Olive Owner"), await colourOf("Eve Editor")];
  expect(o).toEqual({ caret: rgb("#a855f7"), label: rgb("#a855f7") });
  expect(e).toEqual({ caret: rgb("#22c55e"), label: rgb("#22c55e") });
  expect(o.caret).not.toBe(e.caret);

  // Each editor sees the OTHER person's caret, never their own.
  await expect(owner.page.locator(".collaboration-carets__caret")).toHaveCount(1);
  await expect(owner.page.locator(".collaboration-carets__caret", { hasText: "Eve Editor" })).toHaveCount(1);
  await expect(eve.page.locator(".collaboration-carets__caret", { hasText: "Olive Owner" })).toHaveCount(1);
  await expect(eve.page.locator(".collaboration-carets__caret", { hasText: "Eve Editor" })).toHaveCount(0);
  // A caret follows its person.
  await eve.page.getByText("Alpha beta gamma").click();
  await expect.poll(() => tag("Eve Editor").evaluate((el) => el.closest("p")?.textContent ?? "")).toContain("Alpha beta gamma");
  await expect(tag("Olive Owner")).toHaveCount(1);
  await eve.context.close();
  await owner.context.close();
  await sam.context.close();
});

/** NP-PG-08 · "stored on the page and honoured on every device and in collab". */
test("NP-PG-08: page style on a live document is stored on the page and honoured on another device", async ({ browser }) => {
  const owner = await device(browser, "owner", inApp("plan"), { width: 1440, height: 900 });
  await live(owner.page);
  const main = owner.page.locator("#workspace-document");
  const width = () => owner.page.locator("#workspace-document .tiptap").first().evaluate((n) => n.getBoundingClientRect().width);
  const fontSize = () => owner.page.locator("#workspace-document .tiptap p").first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  const [narrow, normal] = [await width(), await fontSize()];
  const body = (await server.note("plan"))!.content;
  const menu = () => owner.page.getByRole("button", { name: "Page actions", exact: true }).click();
  await menu();
  await owner.page.getByRole("menuitem", { name: /Full width/ }).click();
  await expect(main).toHaveAttribute("data-page-full", "true");
  await expect.poll(width).toBeGreaterThan(narrow + 40);
  await menu();
  await owner.page.getByRole("menuitem", { name: /Small text/ }).click();
  await expect(main).toHaveAttribute("data-page-small", "true");
  await expect.poll(fontSize).toBeLessThan(normal);
  // Stored on the page as metadata; the body was not rewritten and the document is still live.
  await expect.poll(async () => (await server.note("plan"))!.metadata?.prism_page_style).toEqual({ small: true, full: true });
  expect((await server.note("plan"))!.content).toBe(body);
  await expect(owner.page.getByText(/Live · /)).toBeVisible();

  // Another device, another person: the same page opens in the same style, and is still one live document.
  const eve = await device(browser, "eve", inApp("plan"), { width: 1440, height: 900 });
  await live(eve.page);
  const theirs = eve.page.locator("#workspace-document");
  await expect(theirs).toHaveAttribute("data-page-full", "true");
  await expect(theirs).toHaveAttribute("data-page-small", "true");
  expect(await eve.page.locator("#workspace-document .tiptap p").first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize))).toBeLessThan(normal);
  await eve.page.getByText("Second paragraph here.").click();
  await eve.page.keyboard.press("End");
  await eve.page.keyboard.type(" Styled and live.");
  await expect(editor(owner.page)).toContainText("Styled and live.");
  // A page that was not styled keeps the default.
  await eve.page.goto(inApp("notes"));
  await live(eve.page);
  await expect(eve.page.locator("#workspace-document")).not.toHaveAttribute("data-page-small", "true");
  // Back to default for the tests that follow.
  await menu();
  await owner.page.getByRole("menuitem", { name: /Full width/ }).click();
  await menu();
  await owner.page.getByRole("menuitem", { name: /Small text/ }).click();
  await expect.poll(async () => (await server.note("plan"))!.metadata?.prism_page_style).toEqual({ small: false, full: false });
  await owner.context.close();
  await eve.context.close();
});

/** NP-CO-14 · "Guests see only what was shared with them, everywhere: sidebar, ⌘K, backlinks, mentions, inbox and databases." */
test("NP-CO-14: a guest's ⌘K, @ menu, Inbox and database view show only what was shared", async ({ browser }) => {
  // A database under the shared page; one of its rows lives outside what was shared.
  expect(await server.add({ id: "gdb", path: "vault/Shared/Plan/Tasks", content: "", metadata: { prism_type: "database", title: "Tasks", prism_database: { version: 1, source: { tags: ["gtask"] }, views: [{ id: "all", name: "All tasks", type: "table" }] } } })).toBe(true);
  expect(await server.add({ id: "gt1", path: "vault/Shared/Plan/Tasks/Visible task", content: "<p>Shared row.</p>", tags: ["gtask"], metadata: { title: "Visible task" } })).toBe(true);
  expect(await server.add({ id: "gt2", path: "vault/Private/Hidden task", content: "<p>Not shared.</p>", tags: ["gtask"], metadata: { title: "Hidden task" } })).toBe(true);

  // ── a guest who may only read ──
  const gina = await device(browser, "gina", "/e2e-fixtures/collab-route.html?app", { width: 1440, height: 900 });
  const shared = gina.page.getByRole("region", { name: "Shared with me" });
  await expect(shared.getByRole("button", { name: /Plan/ })).toBeVisible();
  // ⌘K: a page that was not shared cannot be found; a shared one can.
  const palette = async (page: Page, query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByRole("combobox", { name: "Search notes and commands" });
    await expect(input).toBeVisible();
    await input.fill(query);
    return input;
  };
  await palette(gina.page, "Notes");
  await expect(gina.page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Notes/ }).first()).toBeVisible();
  for (const hidden of ["Budget", "Rich", "Hidden task", "Bomb"]) {
    await gina.page.getByRole("combobox", { name: "Search notes and commands" }).fill(hidden);
    await gina.page.waitForTimeout(900); // past the debounce and both searches
    await expect(gina.page.getByRole("group", { name: "Notes" }).getByRole("option", { name: new RegExp(hidden) })).toHaveCount(0);
  }
  await gina.page.keyboard.press("Escape");
  // The database: only the row inside the shared page.
  await gina.page.evaluate(() => { history.replaceState(null, "", "/"); });
  await gina.page.goto(inApp("gdb"));
  const table = gina.page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: "Visible task", exact: true }), `the page shows: ${await gina.page.locator("body").innerText().then((t) => t.slice(0, 900), () => "?")}`).toBeVisible({ timeout: 15_000 });
  await expect(gina.page.locator("body")).not.toContainText("Hidden task");
  // Nothing addressed to her: the Inbox is empty, and says so.
  await gina.page.goto("/e2e-fixtures/collab-route.html?app");
  const inboxRow = gina.page.locator(".workspace-navigation").first().getByRole("button", { name: /^Inbox/ });
  if (await inboxRow.count()) {
    await inboxRow.click();
    await expect(gina.page.getByTestId("notifications-inbox")).toContainText("You’re all caught up");
    await expect(gina.page.getByTestId("notification-row")).toHaveCount(0);
  }
  await gina.context.close();

  // ── a guest who may edit the shared page: the @ menu offers only pages she can open ──
  const eve = await device(browser, "eve", inApp("plan"), { width: 1440, height: 900 });
  await live(eve.page);
  await eve.page.getByText("Second paragraph here.").click();
  await eve.page.keyboard.press("End");
  await eve.page.keyboard.type(" See @");
  const menu = eve.page.getByRole("listbox", { name: "Mention a person, page or date" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("group", { name: "Dates" }).getByRole("option", { name: /Today/ })).toBeVisible();
  // Nothing outside her shares is offered — no page, no person. (Page suggestions in a live document are
  // the workspace owner's only — CollabDocument — so a guest is offered dates and reminders.)
  for (const hidden of ["Budget", "Hidden task", "Blank"]) await expect(menu.getByRole("option", { name: new RegExp(hidden) })).toHaveCount(0);
  await expect(menu.getByRole("group", { name: "People" })).toHaveCount(0);
  await eve.page.keyboard.type("Bud");
  await eve.page.waitForTimeout(600);
  await expect(eve.page.getByRole("option", { name: /Budget/ })).toHaveCount(0);
  await eve.page.keyboard.press("Escape");
  for (let i = 0; i < 9; i++) await eve.page.keyboard.press("Backspace"); // remove " See @Bud"
  await expect(editor(eve.page)).not.toContainText("@Bud");
  await eve.context.close();
});

/** NP-CO-01 · "… opens a thread in the margin (desktop) or a sheet (phone)". */
test("NP-CO-01: on a phone the comment thread opens in a sheet over the page", async ({ browser }) => {
  const eve = await device(browser, "eve", share("rich"), { width: 390, height: 844 });
  await live(eve.page);
  // Select a word and comment on it.
  await eve.page.evaluate(() => {
    const root = document.querySelector(".tiptap")!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf("quoted");
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + "quoted".length);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    throw new Error("no such text");
  });
  await eve.page.getByRole("button", { name: "Comment on selection" }).click();
  const box = eve.page.getByPlaceholder(/Add a comment/);
  await box.fill("Is this the right quote?");
  await box.press("ControlOrMeta+Enter");
  // The passage is highlighted; tapping it opens its thread.
  const highlight = editor(eve.page).locator("[data-comment-id]");
  await expect(highlight).toHaveText("quoted");
  await highlight.click();
  // The thread is in a sheet layered over the page: fixed, inside the viewport, with a dimmed page behind it.
  const thread = eve.page.locator("[data-comment-id].glass").filter({ hasText: "Is this the right quote?" });
  await expect(thread).toBeVisible();
  const sheet = thread.locator("xpath=ancestor::div[contains(@style,'position: fixed')][1]");
  await expect(sheet).toBeVisible();
  const box2 = (await sheet.boundingBox())!;
  expect(box2.x).toBeGreaterThanOrEqual(0);
  expect(box2.x + box2.width).toBeLessThanOrEqual(390 + 1);
  expect(box2.width).toBeLessThanOrEqual(360);
  expect(box2.width).toBeGreaterThanOrEqual(300);
  expect(box2.height).toBeGreaterThanOrEqual(800);
  expect(await eve.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(thread).toContainText("quoted");
  // Reply inside the sheet.
  const reply = sheet.getByRole("textbox", { name: "Reply" });
  await reply.fill("Yes, keep it.");
  await reply.press("Enter");
  await expect(thread).toContainText("Yes, keep it.");
  // Tapping the dimmed page closes the sheet; the highlight stays in the document.
  await eve.page.mouse.click(8, 400);
  await expect(thread).toHaveCount(0);
  await expect(editor(eve.page).locator("[data-comment-id]")).toHaveText("quoted");
  // The Comments control in the header brings it back.
  await eve.page.getByRole("button", { name: /comments/i }).first().click();
  await expect(eve.page.locator("[data-comment-id].glass").filter({ hasText: "Is this the right quote?" })).toBeVisible();
  await eve.context.close();
});

/** NP-AI-02 · "edits arrive as suggestions with previous/next, accept, dismiss". */
test("NP-AI-02: an agent's edits arrive as suggestions a person steps through, accepts and dismisses", async ({ browser }) => {
  const eve = await device(browser, "eve", inApp("rich"), { width: 1440, height: 900 });
  await live(eve.page);
  await expect(eve.page.locator("[data-suggestion-id]")).toHaveCount(0);
  // The agent acts as her account, with a write credential for Prism's own MCP endpoint.
  const token = await mintAgentToken(eve.page);
  const agent = (name: string, args: Record<string, unknown>) => callTool(token, name, args);
  // Two suggested edits from the agent, while she has the page open.
  await agent("prism_suggest_edit", { id: "rich", find: "A quoted line.", replace: "A cited line." });
  await agent("prism_suggest_edit", { id: "rich", find: "First item", replace: "Opening item" });

  // They arrive in her open document as tracked changes — nothing is applied yet.
  await expect(eve.page.locator('[data-suggestion="insert"]', { hasText: "A cited line." })).toBeVisible();
  await expect(eve.page.locator('[data-suggestion="delete"]', { hasText: "A quoted line." })).toBeVisible();
  await expect(eve.page.locator('[data-suggestion="insert"]', { hasText: "Opening item" })).toBeVisible();
  expect((await server.note("rich"))!.content).not.toContain("<blockquote><p>A cited line.</p>");
  // The review queue: two changes, attributed to the agent.
  const review = eve.page.locator("details.prism-suggestion-review");
  await review.locator("summary").click();
  await expect(review.locator("summary")).toHaveText("2 suggested changes");
  const nav = review.getByRole("navigation", { name: "Suggested changes" });
  await expect(nav).toContainText("Change 1 of 2");
  await expect(review.getByRole("region", { name: "Change by Eve Editor (agent)" })).toBeVisible();
  const first = (await review.locator(".prism-review-after p").textContent())!;
  // Next / previous walk the queue.
  await expect(nav.getByRole("button", { name: "Previous suggested change" })).toBeDisabled();
  await nav.getByRole("button", { name: "Next suggested change" }).click();
  await expect(nav).toContainText("Change 2 of 2");
  const second = (await review.locator(".prism-review-after p").textContent())!;
  expect([first, second].sort()).toEqual(["A cited line.", "Opening item"]);
  await expect(nav.getByRole("button", { name: "Next suggested change" })).toBeDisabled();
  await nav.getByRole("button", { name: "Previous suggested change" }).click();
  await expect(nav).toContainText("Change 1 of 2");
  // Accept the one on screen; dismiss (reject) the other.
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(review.locator("summary")).toHaveText("1 suggested change");
  await review.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(eve.page.locator("[data-suggestion-id]")).toHaveCount(0);
  const [accepted, rejected] = first === "A cited line." ? (["A cited line.", "Opening item"] as const) : (["Opening item", "A cited line."] as const);
  await expect(editor(eve.page)).toContainText(accepted);
  await expect(editor(eve.page)).not.toContainText(rejected);
  await expect(editor(eve.page)).toContainText(rejected === "Opening item" ? "First item" : "A quoted line.");
  await expect(editor(eve.page)).not.toContainText(accepted === "A cited line." ? "A quoted line." : "First item");
  // The stored page ends up with exactly that: the accepted text, no leftover marks.
  await expect.poll(async () => (await server.note("rich"))!.content.includes("data-suggestion"), { timeout: 20_000 }).toBe(false);
  const stored = (await server.note("rich"))!.content;
  expect(stored).toContain(accepted);
  expect(stored).not.toContain(rejected);
  await eve.context.close();
});

/**
 * NP-CO-10 · "… colour-distinct from agent identity".
 * FIXME (behaviour gap, PARITY-GAPS a.1): an agent has no colour of its own — its marks carry the
 * colour of the account it acts for (`colorFor(email)`, apps/server/src/mcp/tool-collab.ts authorOf),
 * which is that person's caret colour, and the caret palette (CollabDoc.tsx COLORS) contains the
 * agent's default green / red.
 */
test.fixme("NP-CO-10: an agent's marks never share a collaborator's caret colour", async ({ browser }) => {
  const owner = await device(browser, "owner", share("notes"));
  const eve = await device(browser, "eve", share("notes"));
  for (const d of [owner, eve]) await live(d.page);
  await owner.page.getByText("Child notes about the plan.").click();
  const caret = eve.page.locator(".collaboration-carets__caret", { hasText: "Olive Owner" });
  await expect(caret).toHaveCount(1);
  const human = await caret.evaluate((el) => getComputedStyle(el).borderLeftColor);
  // The owner's agent suggests an edit on the same page.
  await callTool(await mintAgentToken(owner.page), "prism_suggest_edit", { id: "notes", find: "Child notes", replace: "Sub-page notes" });
  const mark = eve.page.locator('[data-suggestion="insert"][data-user$="(agent)"]').first();
  await expect(mark).toBeVisible();
  const agentColour = await mark.evaluate((el) => { const probe = document.createElement("span"); probe.style.color = el.getAttribute("data-color") ?? ""; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
  expect(agentColour).not.toBe(human);
  await owner.context.close();
  await eve.context.close();
});

/**
 * NP-PG-03 · "a collab title edit syncs to other clients".
 * FIXME (behaviour gap, PARITY-GAPS a.1 — seen failing 2026-10-03, at the last-but-two assertion): the
 * rename itself works (the owner's title, the server's path), but the OTHER client's open live document
 * keeps the old title: `CollabDoc` reads the page's path once, when it opens (and after its own
 * rename), and nothing tells an open document that its page was renamed elsewhere. (This fixture does
 * not bridge the `/api/events` stream either, so the other client's tree and tab are not checked here.)
 */
test.fixme("NP-PG-03: a title edit in a live document reaches another client that has the page open", async ({ browser }) => {
  const owner = await device(browser, "owner", inApp("notes"), { width: 1440, height: 900 });
  const eve = await device(browser, "eve", inApp("notes"), { width: 1440, height: 900 });
  for (const d of [owner, eve]) await live(d.page);
  await expect(eve.page.getByRole("heading", { name: "Rename Notes", exact: true })).toBeVisible();
  // The owner renames the page from its title.
  await owner.page.getByRole("button", { name: "Rename Notes", exact: true }).click();
  const title = owner.page.getByRole("textbox", { name: "Document title" });
  await title.fill("Meeting notes");
  await title.press("Enter");
  await expect(owner.page.getByRole("heading", { name: "Rename Meeting notes", exact: true })).toBeVisible();
  await expect.poll(async () => (await server.note("notes") as unknown as { path?: string } | null)?.path).toBe("vault/Shared/Plan/Meeting notes");
  // The other client, with the same page open, shows the new title without reopening it.
  await expect(eve.page.getByRole("heading", { name: "Rename Meeting notes", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(eve.page.getByRole("heading", { name: "Rename Notes", exact: true })).toHaveCount(0);
  // Its live document was never interrupted.
  await expect(eve.page.getByText(/Live · /)).toBeVisible();
  await owner.context.close();
  await eve.context.close();
});
