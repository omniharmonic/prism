import { test, expect, type Page } from "@playwright/test";

/**
 * Re-review of the offline outbox (C1, H1–H5, M2, M3): every case runs through
 * the real App + React Query + HttpVaultClient + IndexedDB outbox.
 */
const editor = (page: Page) => page.locator(".tiptap[contenteditable=true]");
async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}
type Row = { id: number; method: string; path: string; body?: string; state?: string; kind?: string; detail?: string };
const outbox = (page: Page) => page.evaluate(() => new Promise<Row[]>((resolve) => {
  const open = indexedDB.open("prism-web");
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("outbox")) return resolve([]);
    const all = db.transaction("outbox").objectStore("outbox").getAll();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => resolve([]);
  };
  open.onerror = () => resolve([]);
}));
const writes = (page: Page) => page.evaluate(() => (window as any).prismShell.writes as Array<{ method: string; path: string; body: any }>);
const server = (page: Page, id: string) => page.evaluate((id) => { const n = (window as any).prismShell.note(id); return n ? { content: n.content as string, metadata: n.metadata as Record<string, unknown>, tags: n.tags as string[], path: n.path as string } : null; }, id);
const allNotes = (page: Page) => page.evaluate(() => (window as any).prismShell.all().map((n: any) => ({ id: n.id, path: n.path })) as Array<{ id: string; path: string }>);
const open = (page: Page, id: string, title: string) => page.evaluate(([id, title]) => (window as any).prismShellUI.getState().openTab(id, title, "document"), [id, title]);
const client = <T,>(page: Page, fn: string) => page.evaluate((fn) => (0, eval)(`(async () => { const c = window.prismShellClient; return ${fn}; })()`), fn) as Promise<T>;
const badge = (page: Page) => page.locator(".sync-state-header");
async function ready(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/notion-shell.html${query}`);
  await expect(editor(page)).toBeVisible();
  await expect(badge(page)).toHaveText("Saved");
}
const noReview = async (page: Page) => { await expect(page.getByText("Needs review")).toHaveCount(0); expect((await outbox(page)).filter((r) => r.state && !["queued", "sending"].includes(r.state))).toEqual([]); };

test("C1: an edit folded into a queued row during a flush pass is sent, never dropped", async ({ page, context }) => {
  await ready(page);
  await open(page, "agenda", "Workshop agenda");
  await expect(page.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await context.setOffline(true);
  await type(page, " AGENDA1.");
  await open(page, "workspace", "A living workspace");
  await expect(page.getByText("A shared place to think", { exact: false })).toBeVisible();
  await type(page, " WS1.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(2);
  // Reconnect with the agenda save slow: the flush pass is parked on row 1 while the user keeps typing.
  await page.evaluate(() => { (window as any).prismShell.holdIds.push("agenda"); });
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => ((window as any).prismShell.held.agenda ?? []).length), { timeout: 8000 }).toBe(1);
  await type(page, " WS2.");
  await expect.poll(async () => (await outbox(page)).some((r) => r.path.endsWith("/workspace") && (r.body ?? "").includes("WS2.")), { timeout: 8000 }).toBe(true);
  await page.evaluate(() => (window as any).prismShell.releaseHeld("agenda"));
  await expect(badge(page)).toHaveText("Saved", { timeout: 20000 });
  expect((await server(page, "workspace"))!.content).toContain("WS2.");
  expect((await server(page, "agenda"))!.content).toContain("AGENDA1.");
  expect(await outbox(page)).toHaveLength(0);
  await noReview(page);
  // (The server is the fixture's memory, so "survives a reload" = it reached the server, asserted above.)
});

test("H1: content → property → content offline replays without conflicting with itself", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " One.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Serif font/ }).click();
  await expect.poll(async () => (await outbox(page)).length).toBe(2);
  await type(page, " Two.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(3);
  await context.setOffline(false);
  await expect(badge(page)).toHaveText("Saved", { timeout: 20000 });
  const note = (await server(page, "workspace"))!;
  expect(note.content).toContain("One.");
  expect(note.content).toContain("Two.");
  expect(note.metadata).toMatchObject({ contentFont: "serif", type: "document" });
  await noReview(page);
});

test("H1: content → tag change → content, and two guarded metadata writes, replay cleanly", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " Before tag.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await client(page, `c.addTags("workspace", ["offline-tag"])`);
  await type(page, " After tag.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(3);
  // Two guarded metadata writes, both made from the same local revision as everything above.
  const base = await client<string>(page, `(await c.getNote("workspace")).updatedAt`);
  await client(page, `c.updateNote("workspace", { metadata: { stage: "one" }, ifUpdatedAt: ${JSON.stringify("__BASE__")} })`.replace("__BASE__", base));
  await client(page, `c.updateNote("workspace", { metadata: { stage: "two" }, ifUpdatedAt: ${JSON.stringify("__BASE__")} })`.replace("__BASE__", base));
  expect((await outbox(page)).length).toBe(5);
  await context.setOffline(false);
  await expect(badge(page)).toHaveText("Saved", { timeout: 20000 });
  const note = (await server(page, "workspace"))!;
  expect(note.content).toContain("Before tag.");
  expect(note.content).toContain("After tag.");
  expect(note.tags).toContain("offline-tag");
  expect(note.metadata).toMatchObject({ stage: "two", type: "document" });
  await noReview(page);
});

test("H2: typing after a replayed offline property edit saves without a conflict", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Page actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Mono font/ }).click();
  await expect.poll(async () => (await outbox(page)).length).toBe(1);
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page)).length, { timeout: 15000 }).toBe(0);
  await type(page, " Typed after the property replay.");
  await expect.poll(async () => (await server(page, "workspace"))!.content, { timeout: 10000 }).toContain("Typed after the property replay.");
  await noReview(page);
});

test("H5: a server blip does not turn autosaves into review; a lost acknowledgement is recognised", async ({ page }) => {
  await ready(page);
  // 1) Two 503s, then the server is back: the save retries by itself.
  await page.evaluate(() => { (window as any).prismShell.failures.push({ method: "PATCH", match: "/workspace", mode: 503, times: 2 }); });
  await type(page, " During the blip.");
  await expect.poll(async () => (await server(page, "workspace"))!.content, { timeout: 25000 }).toContain("During the blip.");
  await expect(badge(page)).toHaveText("Saved", { timeout: 10000 });
  await noReview(page);
  // 2) The server applied the save but the response never arrived.
  await page.evaluate(() => { (window as any).prismShell.failures.push({ method: "PATCH", match: "/workspace", mode: "lost", times: 1 }); });
  await type(page, " Lost ack.");
  await expect.poll(async () => (await server(page, "workspace"))!.content, { timeout: 10000 }).toContain("Lost ack.");
  await expect(badge(page)).toHaveText("Saved", { timeout: 25000 });
  await noReview(page);
  // 3) And typing continues to save.
  await type(page, " Still saving.");
  await expect.poll(async () => (await server(page, "workspace"))!.content, { timeout: 10000 }).toContain("Still saving.");
  await noReview(page);
});

test("H4: online but unreachable or 5xx — rename and delete fail honestly, nothing is queued", async ({ page }) => {
  await ready(page);
  for (const mode of ["unreachable", "5xx"] as const) {
    await page.evaluate((mode) => {
      const s = (window as any).prismShell;
      if (mode === "unreachable") s.unreachable = true;
      else { s.unreachable = false; s.failures.push({ method: "PATCH", match: "/agenda", mode: 502, times: 5 }, { method: "DELETE", match: "/agenda", mode: 502, times: 5 }); }
    }, mode);
    const renamed = await client<string>(page, `c.updateNote("agenda", { path: "Library/Renamed" }).then(() => "ok", (e) => "refused: " + e.message)`);
    expect(renamed, mode).toMatch(/^refused/);
    const deleted = await client<string>(page, `c.deleteNote("agenda").then(() => "ok", (e) => "refused: " + e.message)`);
    expect(deleted, mode).toMatch(/^refused/);
    expect(await outbox(page), mode).toHaveLength(0);
  }
  await page.evaluate(() => { const s = (window as any).prismShell; s.unreachable = false; s.failures.length = 0; });
  const agenda = (await server(page, "agenda"))!;
  expect(agenda.path).toBe("Library/Workshop agenda");
});

test("H3: a queued create survives a 5xx and a lost acknowledgement without duplicating the page", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  const nav = page.locator(".workspace-navigation");
  await nav.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await page.keyboard.press("Escape");
  // A second offline "New page" gets its own path (queued creates count as existing pages).
  await nav.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await page.keyboard.press("Escape");
  const queued = (await outbox(page)).filter((r) => r.method === "POST");
  expect(queued).toHaveLength(2);
  const paths = queued.map((r) => JSON.parse(r.body!).path);
  expect(new Set(paths).size).toBe(2);
  // First create: 503 once. Second create: applied, response lost.
  await page.evaluate(() => { (window as any).prismShell.failures.push({ method: "POST", match: "/api/notes", mode: 503, times: 1 }, { method: "POST", match: "/api/notes", mode: "lost", times: 1 }); });
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page)).length, { timeout: 30000 }).toBe(0);
  const created = (await allNotes(page)).filter((n) => paths.includes(n.path));
  expect(created.map((n) => n.path).sort()).toEqual([...paths].sort()); // exactly one page per create
  await noReview(page);
});

test("H3: a create whose path was taken meanwhile goes to review with Retry / Create under another name", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await page.locator(".workspace-navigation").getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
  await page.keyboard.press("Escape");
  const path = JSON.parse((await outbox(page)).find((r) => r.method === "POST")!.body!).path as string;
  await page.evaluate((path) => (window as any).prismShell.serverCreate(path, "<p>Someone else's page.</p>"), path);
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /Needs review/ }).first()).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /Needs review/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Create under another name", exact: true }).click();
  await expect.poll(async () => (await outbox(page)).length, { timeout: 20000 }).toBe(0);
  const all = await allNotes(page);
  expect(all.filter((n) => n.path === path).map((n) => n.id)).toEqual(["foreign-1"]); // theirs untouched
  expect(all.some((n) => n.id.startsWith("created-") && n.path !== path && n.path.startsWith("Projects/Prism/Untitled"))).toBe(true); // ours under a new name
});

test("M2: discarding a conflict never lets the next save overwrite the server's version", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " Mine, offline.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await page.evaluate(() => (window as any).prismShell.serverEdit("workspace", "<p>Server version from another device.</p>"));
  await context.setOffline(false);
  const review = page.getByRole("button", { name: /Needs review/ }).first();
  await expect(review).toBeVisible({ timeout: 20000 });
  // While it waits for review, a fresh read is the SERVER's page, not the stuck text on the server's revision.
  const fresh = await client<{ content: string }>(page, `c.getNote("workspace", { fresh: true })`);
  expect(fresh.content).toBe("<p>Server version from another device.</p>");
  await review.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Discard…" }).click();
  await dialog.getByRole("button", { name: "Discard saved change" }).click();
  await expect.poll(async () => (await outbox(page)).length).toBe(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await type(page, " Typed after discarding.");
  await page.waitForTimeout(4000);
  const after = (await server(page, "workspace"))!.content;
  // Either the page adopted the server's text and saved on top of it, or the new save is held for review — never a silent overwrite.
  const held = (await outbox(page)).some((r) => r.state === "conflict");
  expect(after.includes("Server version from another device.") || held).toBe(true);
  if (!after.includes("Server version from another device.")) expect(after).not.toContain("Typed after discarding.");
});

test("M3: an offline property edit does not overwrite a value changed elsewhere; nested values need a connection", async ({ page, context }) => {
  await ready(page);
  await page.evaluate(() => { const n = (window as any).prismShell.note("workspace"); n.metadata = { ...n.metadata, status: "draft" }; });
  await client(page, `c.getNote("workspace", { fresh: true })`);
  await expect.poll(() => client<string>(page, `(await c.getNote("workspace")).metadata.status`)).toBe("draft");
  await context.setOffline(true);
  await client(page, `c.updateProperties("workspace", { status: "mine" }, { status: "draft" })`);
  await client(page, `c.updateProperties("workspace", { owner: "me" })`);
  const nested = await client<string>(page, `c.updateNote("workspace", { metadata: { prism_database: { version: 1, views: [] } } }).then(() => "queued", (e) => e.message)`);
  expect(nested).toContain("needs a connection");
  const rows = await outbox(page);
  expect(rows).toHaveLength(1); // both property edits folded; the nested one refused
  // Someone else changes `status` meanwhile.
  await page.evaluate(() => { const s = (window as any).prismShell; const n = s.note("workspace"); n.metadata = { ...n.metadata, status: "published" }; s.serverEdit("workspace", n.content); });
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /Needs review/ }).first()).toBeVisible({ timeout: 20000 });
  expect((await server(page, "workspace"))!.metadata.status).toBe("published");
  expect((await outbox(page))[0]!.detail).toContain("status");
});

test("H5: a reload in the middle of a send does not strand the save", async ({ page }) => {
  await ready(page, "?stale=1500");
  await page.evaluate(() => { (window as any).prismShell.holdIds.push("workspace"); });
  await type(page, " Sent, then the tab reloads.");
  await expect.poll(() => page.evaluate(() => ((window as any).prismShell.held.workspace ?? []).length), { timeout: 8000 }).toBe(1);
  // The direct save is in flight; make it a queued row by dropping the connection under it, then reload mid-send.
  await page.evaluate(() => { const s = (window as any).prismShell; s.failures.push({ method: "PATCH", match: "/workspace", mode: "network", times: 1 }); s.releaseHeld("workspace"); });
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  await page.evaluate(() => { (window as any).prismShell.holdIds.push("workspace"); });
  await expect.poll(async () => (await outbox(page))[0]?.state, { timeout: 15000 }).toBe("sending");
  const body = (await outbox(page))[0]!.body!;
  await page.reload();
  await expect(editor(page)).toBeVisible();
  // The dead sender's row goes back in the queue and is delivered by the new page.
  await expect.poll(async () => (await outbox(page)).length, { timeout: 25000 }).toBe(0);
  expect((await server(page, "workspace"))!.content).toBe(JSON.parse(body).content);
  await noReview(page);
});

test("two tabs share one outbox: each row is sent once and both tabs settle", async ({ page, context }) => {
  await ready(page);
  const other = await context.newPage();
  await ready(other);
  await open(other, "agenda", "Workshop agenda");
  await expect(other.getByText("Saturday: opening discussion", { exact: false })).toBeVisible();
  await context.setOffline(true);
  await type(page, " From tab one.");
  await type(other, " From tab two.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(2);
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page)).length, { timeout: 20000 }).toBe(0);
  await expect(badge(page)).toHaveText("Saved", { timeout: 15000 });
  await expect(badge(other)).toHaveText("Saved", { timeout: 15000 });
  // Each tab's fixture is its own "server": whichever tab delivered a row holds its text; nothing was sent twice.
  const sent = [...(await writes(page)), ...(await writes(other))].filter((w) => w.method === "PATCH");
  expect(sent.filter((w) => w.path.endsWith("/workspace"))).toHaveLength(1);
  expect(sent.filter((w) => w.path.endsWith("/agenda"))).toHaveLength(1);
});

test("M4/M5: sign-out warns about unsent changes; a failing device store is a standing banner", async ({ page, context }) => {
  await ready(page);
  await context.setOffline(true);
  await type(page, " Unsent at sign-out.");
  await expect.poll(async () => (await outbox(page)).length, { timeout: 8000 }).toBe(1);
  const leaving = page.evaluate(() => (window as any).prismShellLogout());
  const prompt = page.getByRole("dialog", { name: /hasn’t reached the server/ });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Stay signed in" }).click();
  expect(await leaving).toBe(false);
  expect(await outbox(page)).toHaveLength(1);
  // Storage failure: a standing alert, not a passing toast.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:storage-failed")));
  await expect(page.getByRole("alert").filter({ hasText: "Changes are not being saved on this device" })).toBeVisible();
  // Changes of another account are counted, not hidden.
  await context.setOffline(false);
  await page.evaluate(() => { (window as any).prismShell.actor = "someone-else@example.test"; });
  await page.evaluate(() => (window as any).prismShell.switchActor("someone-else@example.test"));
  await expect(page.getByRole("button", { name: /1 change waiting in another workspace/ })).toBeVisible({ timeout: 10000 });
});
