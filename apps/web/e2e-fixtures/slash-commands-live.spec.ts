/**
 * Slash commands in the REAL web app's live editor (CollabDoc → CollabEditor) against the real
 * Prism Server fixture (gateway, collab socket, attachments, databases over the fake vault).
 * The plain editor's slash items are covered in editor-slash / notion-editor / notion-media /
 * notion-db-inline; this file is the same audit for the editor a signed-in person actually gets.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

const media = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "media", name);
let server: RealServer;
test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
test.afterAll(async () => server?.stop());
test.setTimeout(90_000);

const editor = (page: Page) => page.locator(".tiptap").first();
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as unknown as { editor: { getHTML(): string } }).editor.getHTML());
let seq = 0;
/** A fresh page of the owner's, open in the app's live editor with the caret on an empty last line. */
async function openPage(page: Page, context: BrowserContext, content = "<h2>Heading</h2><p>Start</p>"): Promise<string> {
  const id = `slash-${process.pid}-${++seq}`;
  expect(await server.add({ id, path: `vault/Shared/Slash ${id}`, content, tags: ["team"] })).toBe(true);
  // Nothing outside the fixture is contacted (embeds, link previews).
  await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
  await connect(page, context, server, "owner");
  // Playwright cannot forward a multipart File body (the file reads as empty), so uploads send the same multipart bytes as a buffer.
  await page.addInitScript(() => {
    const send = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!(init?.body instanceof FormData)) return send(input, init);
      const encoded = new Response(init.body);
      const headers = new Headers(init.headers);
      headers.set("Content-Type", encoded.headers.get("Content-Type")!);
      return send(input, { ...init, headers, body: await encoded.arrayBuffer() });
    };
  });
  await page.goto(`/e2e-fixtures/collab-route.html?page=${id}`);
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(editor(page)).toContainText("Start");
  await newLine(page);
  return id;
}
async function newLine(page: Page) {
  await page.evaluate(() => { const ed = (document.querySelector(".tiptap") as unknown as { editor: any }).editor; ed.chain().focus("end").insertContentAt(ed.state.doc.content.size, { type: "paragraph" }).focus("end").run(); });
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".tiptap") as unknown as { editor: any }).editor.state.selection.$from.parent.content.size)).toBe(0);
}
async function slash(page: Page, query: string, option: RegExp) {
  await page.keyboard.type(`/${query}`);
  await page.getByRole("option", { name: option }).click();
}
/** What the server's stored page holds once the live document was written back. */
const stored = async (id: string) => (await server.note(id))?.content ?? "";

test("live: structural blocks — toggle, toggle headings, callout, columns, table, table of contents, link to page", async ({ page, context }) => {
  const id = await openPage(page, context);
  await slash(page, "toggle", /^Toggle Hide content/);
  await page.keyboard.type("Details");
  await newLine(page);
  await slash(page, "toggle heading 2", /^Toggle heading 2/);
  await page.keyboard.type("Section");
  await newLine(page);
  await slash(page, "callout", /^Callout/);
  await page.keyboard.type("Mind the gap");
  for (const n of [2, 3, 4, 5]) {
    await newLine(page);
    await slash(page, `${n} col`, new RegExp(`^${n} columns`));
    await page.keyboard.type(`First of ${n}`);
  }
  await newLine(page);
  await slash(page, "table", /^Table Rows and columns/);
  await page.keyboard.type("Header A");
  await newLine(page);
  await slash(page, "toc", /^Table of contents/);
  await expect(editor(page).locator(".prism-toc")).toContainText("Heading");
  await newLine(page);
  await slash(page, "link", /^Link to page/);
  await expect(page.getByRole("listbox").filter({ hasText: /Plan|Rich|Create page/ })).toBeVisible();
  await page.keyboard.press("Escape");
  const out = await html(page);
  expect(out).toMatch(/<details data-type="toggle"><summary>Details<\/summary><p><\/p><\/details>/);
  expect(out).toMatch(/<details[^>]*data-heading-level="2"[^>]*><summary>Section<\/summary>/);
  expect(out).toMatch(/data-type="callout"><p>Mind the gap<\/p>/);
  for (const n of [2, 3, 4, 5]) expect(out).toMatch(new RegExp(`data-type="columns" data-count="${n}"><div data-type="column"><p>First of ${n}</p>`));
  expect(out).toMatch(/<table[\s\S]*<th[^>]*><p>Header A<\/p><\/th>/);
  expect(out).toContain('data-type="toc"');
  // …and it is what the server stores for the page.
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain('data-count="5"');
  const saved = await stored(id);
  for (const marker of ['data-type="toggle"', 'data-heading-level="2"', 'data-type="callout"', "<table", 'data-type="toc"']) expect(saved).toContain(marker);
});

test("live: media — image upload, image from URL, file, PDF, audio, video", async ({ page, context }) => {
  const id = await openPage(page, context);
  const pick = async (query: string, option: RegExp, file: string) => {
    const chooser = page.waitForEvent("filechooser");
    await slash(page, query, option);
    await (await chooser).setFiles(media(file));
  };
  await pick("image", /^Image Upload or embed/, "cover.png");
  await expect(editor(page).locator('img[src^="/api/attachments/"]')).toHaveCount(1);
  await newLine(page);
  page.once("dialog", (d) => void d.accept("https://images.example.test/chart.png"));
  await slash(page, "image from", /^Image from URL/);
  await expect(editor(page).locator('img[src="https://images.example.test/chart.png"]')).toHaveCount(1);
  for (const [query, option, file, kind] of [["file", /^File Upload any file/, "brief.pdf", "pdf"], ["pdf", /^PDF/, "brief.pdf", "pdf"], ["audio", /^Audio/, "tone.wav", "audio"], ["video", /^Video Upload a video/, "clip.webm", "video"]] as const) {
    const before = await editor(page).locator(`.prism-attachment[data-kind="${kind}"]`).count();
    await newLine(page);
    await pick(query, option, file);
    await expect(editor(page).locator(`.prism-attachment[data-kind="${kind}"]`)).toHaveCount(before + 1);
  }
  await expect(editor(page).locator(".prism-attachment audio[controls]")).toHaveAttribute("src", /^\/api\/attachments\//);
  await expect(editor(page).locator(".prism-attachment video[controls]")).toHaveAttribute("src", /^\/api\/attachments\//);
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain('data-kind="video"');
  expect((await stored(id)).match(/data-type="attachment"/g)).toHaveLength(4);
});

test("live: web bookmark and embed", async ({ page, context }) => {
  const id = await openPage(page, context);
  page.once("dialog", (d) => void d.accept("https://atlas.example.test/watersheds"));
  await slash(page, "bookmark", /^Web bookmark/);
  await expect(editor(page).locator(".prism-bookmark")).toHaveCount(1);
  await expect(editor(page).locator(".prism-bookmark")).toContainText("atlas.example.test");
  await newLine(page);
  page.once("dialog", (d) => void d.accept("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  await slash(page, "embed", /^Embed YouTube/);
  await expect(editor(page).locator('.prism-embed iframe[src*="youtube"]')).toHaveCount(1);
  const out = await html(page);
  expect(out).toContain('data-type="bookmark"');
  expect(out).toMatch(/data-type="embed"[^>]*data-url="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"|data-url="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"[^>]*data-type="embed"/);
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain('data-type="embed"');
});

test("live: Page adds the sub-page row, for this client and for the stored page", async ({ page, context }) => {
  const id = await openPage(page, context);
  await slash(page, "page", /^Page Add a sub-page/);
  await expect(editor(page).locator(".prism-child-page")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open sub-page: Untitled" })).toBeVisible();
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain('data-type="child-page"');
});

test("live: Page keeps its row when the editor is replaced while the page is created", async ({ page, context }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let posted = false;
  const id = await openPage(page, context);
  await page.route((url) => url.pathname === "/api/notes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted = true;
    await held;
    return route.fallback();
  });
  await page.keyboard.type("/page");
  await page.keyboard.press("Enter");
  await expect.poll(() => posted).toBe(true);
  // A permission change anywhere in the workspace closes every live session ("Access changed."):
  // the page shows "Checking updated access…" and comes back with a NEW editor on the same document.
  await page.evaluate(() => { (document.querySelector(".tiptap") as HTMLElement).dataset.before = "1"; });
  const changed = await page.evaluate(async () => (await fetch("/acl/notes/blank/tags", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "reviewed" }) })).status);
  expect(changed).toBe(200);
  await expect(page.locator(".tiptap:not([data-before])")).toBeVisible();
  await expect(page.getByText(/Live · /)).toBeVisible();
  release();
  await expect(editor(page).locator(".prism-child-page")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open sub-page: Untitled" })).toBeVisible();
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain('data-type="child-page"');
});

test("live: databases — a new inline view of each layout, a linked view, and a full-page database", async ({ page, context }) => {
  const id = await openPage(page, context);
  const layouts = [["table view", /^Table view/, "table"], ["board view", /^Board view/, "board"], ["gallery", /^Gallery/, "gallery"], ["list view", /^List A new database as a list/, "list"], ["calendar", /^Calendar A new database/, "calendar"]] as const;
  let blocks = 0;
  let treeReads = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/tree") treeReads++; });
  for (const [query, option, label] of layouts) {
    if (blocks) await newLine(page);
    await slash(page, query, option);
    const dialog = page.getByRole("dialog", { name: `New ${label} database` });
    await dialog.getByRole("textbox").fill(`slash${label}`);
    const readsBefore = treeReads;
    await dialog.getByRole("button", { name: "Create database" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(editor(page).locator(".prism-database-block")).toHaveCount(++blocks);
    // The new database is a page: the tree is read again (this fixture has no events channel to do it).
    await expect.poll(() => treeReads, { message: `tree refreshed after the ${label} database` }).toBeGreaterThan(readsBefore);
  }
  await newLine(page);
  await slash(page, "linked", /^Linked view of database/);
  const link = page.getByRole("dialog", { name: "Link a database" });
  await link.getByRole("textbox", { name: "Search databases" }).fill("slashtable");
  await link.getByRole("option", { name: "slashtable database" }).click();
  await expect(link).toHaveCount(0);
  await expect(editor(page).locator(".prism-database-block")).toHaveCount(++blocks);
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain("data-prism-database");
  expect((await stored(id)).match(/data-prism-database=/g)).toHaveLength(6);
  // Full-page database: a sub-page, opened in its own tab, with a link left here.
  await newLine(page);
  await slash(page, "full page", /^Full-page database/);
  // (This fixture server cannot write tag schemas, so the "new tag" form is not driven here —
  // notion-db-new.spec.ts covers it; "Use an existing tag" is the same create + link + open.)
  await page.getByRole("dialog", { name: "New database" }).getByRole("button", { name: "Use an existing tag" }).click();
  const dialog = page.getByRole("dialog", { name: "New full-page database" });
  await dialog.getByRole("textbox").fill("team");
  await dialog.getByRole("button", { name: "Create database" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open team database" })).toBeVisible();
  await expect.poll(() => stored(id), { timeout: 20_000 }).toContain(`[[vault/Shared/Slash ${id}/team database]]`);
  expect((await stored(id)).match(/data-prism-database=/g)).toHaveLength(6); // a link, not a seventh inline block
});

test("live: Ask agent opens the conversation about this page", async ({ page, context }) => {
  await openPage(page, context);
  await page.keyboard.type("/ask");
  const option = page.getByRole("option", { name: /^Ask agent/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole("listbox", { name: "Insert block" })).toHaveCount(0);
  // The typed command is gone and the agent panel is open.
  expect(await html(page)).not.toContain("/ask");
  await expect(page.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
});
