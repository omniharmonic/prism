import { test, expect, type Page } from "@playwright/test";

/**
 * Review of NP-OF-05 (live updates into an open PLAIN editor) — the data-loss
 * paths, each pinned. The real App + HttpVaultClient over the shell fixture,
 * whose "server" enforces the vault's compare-and-set; `prismShell.event(id)`
 * stands in for `/api/events` and `prismShell.serverEdit` for another device.
 */
const url = (q = "") => `/e2e-fixtures/notion-shell.html?events${q}`;
const editor = (page: Page) => page.locator(".tiptap");
const shell = <T,>(page: Page, fn: (s: any) => T) => page.evaluate(`(${fn.toString()})(window.prismShell)`) as Promise<T>;
const remoteEdit = (page: Page, id: string, html: string) => page.evaluate(([id, html]) => { const s = (window as any).prismShell; s.serverEdit(id, html); s.event(id); }, [id, html] as const);
const reRead = async (page: Page, id: string, after: number) => expect.poll(() => page.evaluate((id) => ((window as any).prismShell.reads as string[]).filter((x) => x === id).length, id)).toBeGreaterThan(after);
const reads = (page: Page, id: string) => page.evaluate((id) => ((window as any).prismShell.reads as string[]).filter((x) => x === id).length, id);
/** Mark the editor's DOM node: a remount replaces it, so the mark disappears. */
const mark = (page: Page) => editor(page).evaluate((el) => { (el as any).__kept = true; });
const kept = (page: Page) => editor(page).evaluate((el) => (el as any).__kept === true);
const REMOTE = "<p>Edited on the other device.</p>";

async function ready(page: Page, q = "") {
  await page.goto(url(q));
  await expect(editor(page)).toContainText("A shared place to think");
}

/** C1 — propose mode never saves, so its draft exists only in the editor. */
test("C1: a propose-mode draft is never replaced by a remote edit", async ({ page }) => {
  await ready(page, "&as=governed");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" My proposed change.");
  await page.locator("h1").first().click({ position: { x: 2, y: 2 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // idle, unfocused: the case that used to adopt
  await mark(page);
  const before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await reRead(page, "workspace", before);
  await page.waitForTimeout(900);
  await expect(editor(page)).toContainText("My proposed change.");
  await expect(editor(page)).not.toContainText("Edited on the other device.");
  expect(await kept(page)).toBe(true);
  // Told about it, with no way to throw the draft away by accident.
  const review = page.getByTestId("remote-update-review");
  await expect(review).toContainText("This page was updated elsewhere");
  await expect(review).toContainText("Your draft is kept here");
  await expect(review.getByRole("button", { name: "Show latest" })).toHaveCount(0);
  await review.getByRole("button", { name: "Dismiss" }).click();
  await expect(editor(page)).toContainText("My proposed change.");
  expect(await shell(page, (s) => s.writes.length)).toBe(0);
});

/** H1 — the save's base is the revision the editor MOUNTED from, not whatever the cache was re-read to. */
test("H1: unsaved typing + a remote edit conflicts (409 → Needs review); the remote edit is not overwritten", async ({ page }) => {
  await ready(page);
  const base = await shell(page, (s) => s.note("workspace").updatedAt as string);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed here.");
  // Another device saves while this draft is unsent; the event re-reads the page (the cache now holds the NEW revision).
  const before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await reRead(page, "workspace", before);
  const remoteRevision = await shell(page, (s) => s.note("workspace").updatedAt as string);
  expect(remoteRevision).not.toBe(base);
  // The autosave fires: it must name ITS base and be refused.
  await expect.poll(() => shell(page, (s) => s.writes.filter((w: any) => w.method === "PATCH" && w.path === "/api/notes/workspace" && "content" in (w.body ?? {})).length), { timeout: 8000 }).toBeGreaterThan(0);
  const save = await shell(page, (s) => s.writes.find((w: any) => w.method === "PATCH" && w.path === "/api/notes/workspace" && "content" in (w.body ?? {})).body);
  expect(save.if_updated_at).toBe(base);
  expect(save.force).toBeUndefined();
  // The server still holds the other device's text; nothing was lost on either side.
  await page.waitForTimeout(400);
  expect(await shell(page, (s) => s.note("workspace").content as string)).toBe(REMOTE);
  expect(await shell(page, (s) => s.note("workspace").updatedAt as string)).toBe(remoteRevision);
  await expect(editor(page)).toContainText("Typed here.");
  await expect(page.locator('[data-sync-state="review"]').first()).toBeVisible({ timeout: 8000 });
});

/** H1 — the editor's own saves, and metadata writes to the same page, do not make it conflict with itself. */
test("H1: consecutive saves and a metadata write in between never self-conflict", async ({ page }) => {
  await ready(page);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" One.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => shell(page, (s) => String(s.note("workspace").content).includes("One."))).toBe(true);
  // Same content, newer revision: an icon set from this page.
  await page.getByRole("button", { name: "Add icon" }).click();
  await page.locator(".EmojiPickerReact button.epr-emoji:visible").first().click();
  await expect.poll(() => shell(page, (s) => typeof s.note("workspace").metadata.icon)).toBe("string");
  // …and one set by another device (the event re-read brings the same content under a newer revision).
  const before = await reads(page, "workspace");
  await page.evaluate(() => { const s = (window as any).prismShell; const n = s.note("workspace"); s.serverEdit("workspace", n.content); s.event("workspace"); });
  await reRead(page, "workspace", before);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Two.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => shell(page, (s) => String(s.note("workspace").content).includes("Two."))).toBe(true);
  await expect(page.locator('[data-sync-state="review"]')).toHaveCount(0);
  await expect(page.getByTestId("remote-update-review")).toHaveCount(0);
  // The revision moves again with the SAME content and this client has NOT heard of it yet
  // (no event, no re-read): the save's 409 is not a content conflict — re-based and sent once more.
  await page.evaluate(() => { const s = (window as any).prismShell; s.serverEdit("workspace", s.note("workspace").content); });
  const stale = await shell(page, (s) => s.note("workspace").updatedAt as string);
  await page.keyboard.type(" Three.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => shell(page, (s) => String(s.note("workspace").content).includes("Three."))).toBe(true);
  const sent = await shell(page, (s) => s.writes.filter((w: any) => w.method === "PATCH" && w.path === "/api/notes/workspace" && "content" in (w.body ?? {})).slice(-2).map((w: any) => w.body.if_updated_at));
  expect(sent[1]).toBe(stale); // the retry named the revision the server actually holds
  expect(sent[0]).not.toBe(stale); // …after the first attempt named the editor's own, older base
  await expect(page.locator('[data-sync-state="review"]')).toHaveCount(0);
});

/** H2 + M2 — never swapped under someone who is in the page; the review preview is how they see it. */
test("H2: with the caret in the page a remote edit is offered, not applied; Show latest adopts and keeps the scroll position", async ({ page }) => {
  await ready(page);
  // A long page, scrolled, caret in the body, nothing unsaved.
  await page.evaluate(() => { const s = (window as any).prismShell; s.note("agenda").content = Array.from({ length: 120 }, (_, i) => `<p>Agenda line ${i + 1}</p>`).join(""); (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"); });
  await expect(editor(page)).toContainText("Agenda line 120");
  const scroller = page.locator("#workspace-document .document-writing-scroll");
  await scroller.evaluate((el) => { el.scrollTop = 900; });
  await editor(page).locator("p", { hasText: "Agenda line 40" }).first().click();
  await mark(page);
  const top = await scroller.evaluate((el) => el.scrollTop);
  const before = await reads(page, "agenda");
  await remoteEdit(page, "agenda", Array.from({ length: 120 }, (_, i) => `<p>Remote line ${i + 1}</p>`).join(""));
  await reRead(page, "agenda", before);
  const review = page.getByTestId("remote-update-review");
  await expect(review).toContainText("This page was updated elsewhere");
  // Not applied: same editor, same text, the caret still works.
  expect(await kept(page)).toBe(true);
  await expect(editor(page)).toContainText("Agenda line 40");
  await expect(editor(page)).not.toContainText("Remote line 40");
  // "Show latest" (nothing unsaved): the latest version, at the same place on the page, nothing written.
  await review.getByRole("button", { name: "Show latest" }).click();
  await expect(editor(page)).toContainText("Remote line 40");
  await expect(review).toHaveCount(0);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(top);
  expect(await shell(page, (s) => s.writes.filter((w: any) => w.path === "/api/notes/agenda").length)).toBe(0);
});

test("H2: a title being typed survives a remote edit; idle and unfocused, the page updates silently with no leftover review", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Rename A living workspace", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("A living pla");
  let before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await reRead(page, "workspace", before);
  await page.waitForTimeout(700);
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("A living pla");
  await expect(editor(page)).not.toContainText("Edited on the other device.");
  await expect(page.getByTestId("remote-update-review")).toBeVisible();
  // Leave the title (Esc) and take the latest.
  await title.press("Escape");
  await page.getByTestId("remote-update-review").getByRole("button", { name: "Show latest" }).click();
  await expect(editor(page)).toContainText("Edited on the other device.");
  // Idle and unfocused: silent, and no stale "review" surface is left behind (M2).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", "<p>Second remote edit.</p>");
  await expect(editor(page)).toContainText("Second remote edit.", { timeout: 4000 });
  await expect(page.getByTestId("remote-update-review")).toHaveCount(0);
  await expect(page.getByTestId("remote-update-bar")).toHaveCount(0);
});

/** H3 — an older copy (a reuse window, a slow read) is never adopted; the re-read asks for the current state. */
test("H3: an older copy is never adopted, and an event-driven re-read asks the server for its current state", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Adopt a newer version first (idle).
  let before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await expect(editor(page)).toContainText("Edited on the other device.", { timeout: 4000 });
  expect(await shell(page, (s) => s.freshReads.includes("workspace"))).toBe(true);
  // Now a re-read is answered with an OLDER revision (different content).
  await mark(page);
  before = await reads(page, "workspace");
  await page.evaluate(() => {
    const s = (window as any).prismShell;
    s.staleOnce.workspace = { ...s.note("workspace"), content: "<p>An older copy.</p>", updatedAt: "2026-01-01T00:00:00.000Z" };
    s.event("workspace");
  });
  await reRead(page, "workspace", before);
  await page.waitForTimeout(900);
  await expect(editor(page)).toContainText("Edited on the other device.");
  await expect(editor(page)).not.toContainText("An older copy.");
  expect(await kept(page)).toBe(true);
  await expect(page.getByTestId("remote-update-review")).toHaveCount(0);
});

/** H3 — the outbox maps a base only across THIS device's own confirmed writes; it never launders one past a remote revision. */
test("H3: after an offline save is delivered, a later remote edit still conflicts with the next local save", async ({ page, context }) => {
  await ready(page);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  // Offline: the save is queued (the editor's base stays the revision it mounted from).
  await context.setOffline(true);
  await page.keyboard.type(" Offline line.");
  await page.keyboard.press("ControlOrMeta+s");
  await context.setOffline(false);
  // Delivered: the server now holds it (revision B), and this device knows A → B was its own write.
  await expect.poll(() => shell(page, (s) => String(s.note("workspace").content).includes("Offline line.")), { timeout: 15_000 }).toBe(true);
  await expect(page.locator(".sync-state-header")).toHaveText("Saved", { timeout: 15_000 });
  // A local save on top of its own delivered write is fine (A is mapped to B, not refused).
  await page.keyboard.type(" Next.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => shell(page, (s) => String(s.note("workspace").content).includes("Next.")), { timeout: 10_000 }).toBe(true);
  // Another device edits (revision C) and this client is told; the caret is in the page, so nothing is swapped.
  const before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await reRead(page, "workspace", before);
  const remoteRevision = await shell(page, (s) => s.note("workspace").updatedAt as string);
  await page.getByTestId("remote-update-review").getByRole("button", { name: "Keep mine" }).click();
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" After the remote edit.");
  await page.keyboard.press("ControlOrMeta+s");
  // Refused: the base named is one of this device's own revisions, never C.
  await expect(page.locator('[data-sync-state="review"]').first()).toBeVisible({ timeout: 10_000 });
  const last = await shell(page, (s) => s.writes.filter((w: any) => w.method === "PATCH" && w.path === "/api/notes/workspace" && "content" in (w.body ?? {})).at(-1).body);
  expect(last.if_updated_at).not.toBe(remoteRevision);
  expect(await shell(page, (s) => s.note("workspace").content as string)).toBe(REMOTE);
  await expect(editor(page)).toContainText("After the remote edit.");
});

/** M1 — content edits elsewhere never refetch the tree; a changed ROW does, at once. */
test("M1: the sidebar tree is refetched only for events that changed a row", async ({ page }) => {
  await ready(page);
  await expect(page.locator(".workspace-navigation")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(700);
  const start = await shell(page, (s) => s.treeReads as number);
  for (let i = 0; i < 4; i++) {
    const before = await reads(page, "agenda");
    await page.evaluate((i) => { const s = (window as any).prismShell; s.serverEdit("field-notes", `<p>Edit ${i}</p>`); s.event("field-notes"); s.event("agenda"); }, i);
    await page.waitForTimeout(700);
    void before;
  }
  expect(await shell(page, (s) => s.treeReads as number)).toBe(start);
  // A rename elsewhere: flagged by the server → the sidebar shows it without a reload.
  await page.evaluate(() => { const s = (window as any).prismShell; s.note("agenda").path = "Library/Renamed agenda"; s.event("agenda", true); });
  await expect.poll(() => shell(page, (s) => s.treeReads as number)).toBe(start + 1);
});

/** M3 — the local icon override is not a second source of truth. */
test("M3: a refused icon write does not leave the icon showing in tabs and the sidebar", async ({ page }) => {
  await ready(page);
  const tabs = page.getByRole("navigation", { name: "Open document tabs" });
  await page.evaluate(() => { (window as any).prismShell.failures.push({ method: "PATCH", match: "/notes/workspace", mode: 403, times: 5 }, { method: "POST", match: "/properties/workspace", mode: 403, times: 5 }); });
  await page.getByRole("button", { name: "Add icon" }).click();
  await page.locator(".EmojiPickerReact button.epr-emoji:visible").first().click();
  await expect.poll(() => shell(page, (s) => s.writes.some((w: any) => w.body?.failed === 403))).toBe(true);
  await expect(tabs.locator('[data-page-icon="workspace"]')).toHaveCount(0);
  expect(await shell(page, (s) => s.note("workspace").metadata.icon)).toBeUndefined();
});

/**
 * Editor group (4A) × live updates (4B). Every local change the block editor makes
 * — a block command included, not only typing — is a ProseMirror transaction, so it
 * marks the editor's autosave touched and its save names the editor's OWN base.
 */
const contentSaves = (page: Page, id: string) => page.evaluate((id) => ((window as any).prismShell.writes as any[]).filter((w) => w.method === "PATCH" && w.path === `/api/notes/${id}` && w.body && "content" in w.body), id);

test("4A×4B: a block command (no typing) makes the editor dirty; a remote edit is offered, and the save names the editor's own base", async ({ page }) => {
  await ready(page);
  const base = await shell(page, (s) => s.note("workspace").updatedAt as string);
  // Duplicate the paragraph from the block menu — a command, not a keystroke.
  await editor(page).locator("p").first().hover();
  await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(editor(page).locator("p").filter({ hasText: "A shared place to think" })).toHaveCount(2);
  // Idle and unfocused: a CLEAN editor would now adopt the remote version silently.
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.getSelection()?.removeAllRanges(); });
  await page.mouse.move(700, 700);
  await mark(page);
  const before = await reads(page, "workspace");
  await remoteEdit(page, "workspace", REMOTE);
  await reRead(page, "workspace", before);
  const remoteRevision = await shell(page, (s) => s.note("workspace").updatedAt as string);
  // Offered, not applied: the duplicated block is still on screen in the same editor.
  await expect(page.getByTestId("remote-update-review")).toContainText("This page was updated elsewhere");
  expect(await kept(page)).toBe(true);
  await expect(editor(page).locator("p").filter({ hasText: "A shared place to think" })).toHaveCount(2);
  // Its autosave names the revision the editor mounted from → refused → review; the remote edit stands.
  await expect.poll(async () => (await contentSaves(page, "workspace")).length, { timeout: 8000 }).toBeGreaterThan(0);
  const save = (await contentSaves(page, "workspace"))[0].body;
  expect(save.if_updated_at).toBe(base);
  expect(save.force).toBeUndefined();
  await expect(page.locator('[data-sync-state="review"]').first()).toBeVisible({ timeout: 8000 });
  expect(await shell(page, (s) => s.note("workspace").content as string)).toBe(REMOTE);
  expect(await shell(page, (s) => s.note("workspace").updatedAt as string)).toBe(remoteRevision);
});

test("4A×4B: Move to — the source saves on its own base, and the target page opens on the appended blocks (never overwritten)", async ({ page }) => {
  await ready(page);
  // The target has been open in this session: its pre-move copy is in the cache.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(editor(page)).toContainText("Saturday: opening discussion");
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("workspace", "A living workspace", "document"));
  await expect(editor(page)).toContainText("A shared place to think");
  const base = await shell(page, (s) => s.note("workspace").updatedAt as string);
  await editor(page).locator("p").first().hover();
  await page.locator(".block-gutter").getByRole("button", { name: /Drag to move/ }).click();
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menu", { name: "Move to" }).getByRole("menuitem", { name: "Workshop agenda" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Moved to Workshop agenda" })).toBeVisible();
  await expect(editor(page)).not.toContainText("A shared place to think");
  // The source's removal is a local change like any other: saved once, on its own base.
  await expect.poll(async () => (await contentSaves(page, "workspace")).length, { timeout: 8000 }).toBe(1);
  const save = (await contentSaves(page, "workspace"))[0].body;
  expect(save.if_updated_at).toBe(base);
  expect(save.content).not.toContain("A shared place to think");
  await expect(page.locator('[data-sync-state="review"]')).toHaveCount(0);
  // The target shows the server's appended version, and never writes its stale copy back.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agenda", "Workshop agenda", "document"));
  await expect(editor(page)).toContainText("A shared place to think");
  await expect(editor(page)).toContainText("Saturday: opening discussion");
  await page.waitForTimeout(2600); // past the autosave debounce: a stale write-back would have gone out
  expect(await contentSaves(page, "agenda")).toHaveLength(0);
  expect(await shell(page, (s) => s.note("agenda").content as string)).toContain("A shared place to think");
});

/** The append arriving at a page that is OPEN (from another window's "Move to"): a remote edit like any other. */
const appendElsewhere = (page: Page, id: string, html: string) => page.evaluate(async ([id, html]) => {
  const r = await fetch(`/api/notes/${id}/blocks/append`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, requestId: `req-${Date.now()}` }) });
  if (!r.ok) throw new Error(String(r.status));
}, [id, html] as const);

test("4A×4B: blocks appended to the OPEN plain page are adopted when it is clean and idle", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.getSelection()?.removeAllRanges(); });
  const before = await reads(page, "workspace");
  await appendElsewhere(page, "workspace", "<p>Moved in from another page.</p>");
  await reRead(page, "workspace", before);
  await expect(editor(page)).toContainText("Moved in from another page.");
  await expect(editor(page)).toContainText("A shared place to think");
  await expect(page.getByTestId("remote-update-review")).toHaveCount(0);
  expect(await contentSaves(page, "workspace")).toHaveLength(0);
});

test("4A×4B: blocks appended to the OPEN plain page while it holds unsaved typing are kept on the server; the draft goes to review", async ({ page }) => {
  await ready(page);
  const base = await shell(page, (s) => s.note("workspace").updatedAt as string);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed here.");
  const before = await reads(page, "workspace");
  await appendElsewhere(page, "workspace", "<p>Moved in from another page.</p>");
  await reRead(page, "workspace", before);
  await expect(page.getByTestId("remote-update-review")).toContainText("This page was updated elsewhere");
  await expect(editor(page)).toContainText("Typed here.");
  await expect.poll(async () => (await contentSaves(page, "workspace")).length, { timeout: 8000 }).toBeGreaterThan(0);
  expect((await contentSaves(page, "workspace"))[0].body.if_updated_at).toBe(base);
  await expect(page.locator('[data-sync-state="review"]').first()).toBeVisible({ timeout: 8000 });
  const stored = await shell(page, (s) => s.note("workspace").content as string);
  expect(stored).toContain("Moved in from another page.");
  expect(stored).not.toContain("Typed here.");
});
