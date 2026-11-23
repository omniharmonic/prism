import { test, expect } from "@playwright/test";

/**
 * NP-OF-05 — live updates from another device or the agent appear without a
 * reload within 2 s. The fixture's invalidation source stands in for
 * `GET /api/events` (ids only); the "other device" edits the note on the
 * fixture server and the event tells this client which id to re-read.
 * The real SSE transport is covered by `npm run verify:events -w @prism/web`,
 * live collab documents by editor-blocks / suggest-only / notion-presence.
 */
const path = "/e2e-fixtures/workspace.html?session&events";
const WITHIN = { timeout: 2000 };

// An idle open plain editor takes the remote version (Canvas + remoteAdoption); a dirty one keeps its draft (below).
test("remote edit appears within 2s", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap");
  await expect(editor).toContainText("Useful observations from our last conversation.");
  const readsBefore = await page.evaluate(() => ((window as any).prismFixtureReads as string[]).length);

  // Another device saves the page; this client only receives the id.
  await page.evaluate(() => {
    const note = ((window as any).prismFixtureNotes as any[]).find((n) => n.id === "field-notes");
    note.content = "<h1>Field notes</h1><p>Edited on the other device.</p>";
    note.updatedAt = "2026-10-01T12:05:00.000Z";
    (window as any).prismFixtureInvalidate("field-notes");
  });
  await expect(editor).toContainText("Edited on the other device.", WITHIN);
  await expect(editor).not.toContainText("Useful observations from our last conversation.");
  // It was a re-read of that page, not a reload of the app, and nothing was written back.
  expect(await page.evaluate(() => ((window as any).prismFixtureReads as string[]).length)).toBeGreaterThan(readsBefore);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});

// A note event for an id the tree has never listed refreshes ["vault","tree"] at once (lib/events/invalidation.ts).
test("a page created elsewhere appears in the tree within 2s", async ({ page }) => {
  await page.goto(path + "&navigation");
  const nav = page.locator(".workspace-navigation");
  await expect(nav).toBeVisible();
  await expect(nav.getByText("Made on the phone")).toHaveCount(0);
  await page.evaluate(() => {
    ((window as any).prismFixtureNotes as any[]).push({ id: "from-phone", path: "Made on the phone", content: "<p>New</p>", tags: ["note"], metadata: { type: "document" }, createdAt: "2026-10-01T12:06:00.000Z", updatedAt: "2026-10-01T12:06:00.000Z" });
    (window as any).prismFixtureInvalidate("from-phone");
  });
  await expect(nav.getByText("Made on the phone")).toBeVisible(WITHIN);
});

// Never clobber typing: with unsent local edits the remote version is NOT adopted.
test("a remote edit never replaces unsaved typing", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap");
  await expect(editor).toContainText("Useful observations from our last conversation.");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed here and not yet saved.");
  await page.evaluate(() => {
    const note = ((window as any).prismFixtureNotes as any[]).find((n) => n.id === "field-notes");
    note.content = "<h1>Field notes</h1><p>Edited on the other device.</p>";
    note.updatedAt = "2026-10-01T12:05:00.000Z";
    (window as any).prismFixtureInvalidate("field-notes");
  });
  const reads = () => page.evaluate(() => ((window as any).prismFixtureReads as string[]).filter((id) => id === "field-notes").length);
  const before = await reads();
  await expect.poll(reads, WITHIN).toBeGreaterThan(before - 1);
  await page.waitForTimeout(1200); // past the 500 ms batch + the re-read
  await expect(editor).toContainText("Typed here and not yet saved.");
  await expect(editor).not.toContainText("Edited on the other device.");
});

// The event makes this client re-read exactly that page (no reload, no write-back). the event makes this client re-read exactly that page (no reload, no write-back).
test("a remote change event re-reads the open page from the server", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.locator(".tiptap")).toContainText("Useful observations from our last conversation.");
  const reads = () => page.evaluate(() => ((window as any).prismFixtureReads as string[]).filter((id) => id === "field-notes").length);
  const before = await reads();
  await page.evaluate(() => (window as any).prismFixtureInvalidate("field-notes"));
  await expect.poll(reads, WITHIN).toBeGreaterThan(before);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});
