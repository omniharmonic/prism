/**
 * Project pages in the REAL web app's live editor (CollabDoc → CollabEditor) against the real
 * Prism Server fixture (gateway + collab socket + conversion worker over the fake vault).
 * This is the editor a signed-in person gets for a `project` note since Phase 0 — the note was
 * never live-editable before. `project-pages.spec.ts` covers the plain editor and the tree.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";
import { largeMarkdown } from "./project-pages-data";

let server: RealServer;
test.beforeAll(async ({}, info) => { server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188")); });
test.afterAll(async () => server?.stop());
test.setTimeout(120_000);

const editor = (page: Page) => page.locator(".tiptap").first();
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open document tabs" });
let seq = 0;
const SMALL = [
  "# Bioregional Food Chain", "",
  "**Status:** active. Stewarded with [[Ada Park]] — see the *working agreement*.", "",
  "## Goals", "",
  "- Map every grower within **fifty miles**", "",
  "Closing paragraph.",
].join("\n");

async function seed(content: string, metadata: Record<string, unknown> = {}): Promise<{ id: string; path: string }> {
  const id = `proj-${process.pid}-${++seq}`;
  const path = `vault/projects/food-chain-${process.pid}-${seq}/PROJECT`;
  expect(await server.add({ id, path, content, tags: ["project"], metadata: { type: "project", status: "active", ...metadata } })).toBe(true);
  return { id, path };
}
async function openLive(page: Page, context: BrowserContext, id: string) {
  await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
  await connect(page, context, server, "owner");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/e2e-fixtures/collab-route.html?page=${id}`);
  await expect(page.getByText(/Live · /)).toBeVisible({ timeout: 60_000 });
}
/** The note as the fake vault holds it now. */
const stored = async (_page: Page, id: string) => {
  const n = (await server.note(id))!;
  return { path: n.path ?? null, content: n.content, metadata: n.metadata ?? {} };
};

test("live: a project page has a real title, a formatted editable body and its properties", async ({ page, context }) => {
  const { id, path } = await seed(SMALL, { name: "Bioregional Food Chain" });
  await openLive(page, context, id);
  await expect(page.getByRole("heading", { level: 1, name: "Rename Bioregional Food Chain", exact: true })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Bioregional Food Chain", exact: true })).toBeVisible();
  await expect(page.getByText("PROJECT", { exact: true })).toHaveCount(0);
  const doc = editor(page);
  await expect(doc.locator("strong", { hasText: "Status:" })).toBeVisible();
  await expect(doc.locator("em", { hasText: "working agreement" })).toBeVisible();
  await expect(doc.locator("h2", { hasText: "Goals" })).toBeVisible();
  expect(await doc.evaluate((el) => (el as HTMLElement).innerText)).not.toContain("**");
  await expect(doc.locator(".wikilink").first()).toBeVisible();
  const props = page.getByRole("group", { name: "Page properties" });
  await expect(props).toBeVisible();
  await expect(props).toContainText(/status/i);
  await expect(props).toContainText(/active/i);
  // Editable: what is typed reaches the stored page, at the same path.
  await expect(doc).toHaveAttribute("contenteditable", "true");
  await doc.locator("p", { hasText: "Closing paragraph." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed live.");
  await expect.poll(async () => (await server.note(id))?.content ?? "", { timeout: 30_000 }).toContain("Typed live.");
  const after = await stored(page, id);
  expect(after.path).toBe(path);
  for (const kept of ["Bioregional Food Chain", "<strong>Status:</strong>", "Map every grower", "Ada Park"]) expect(after.content).toContain(kept);
  expect(after.metadata.status).toBe("active");
});

test("live: editing the title stores `metadata.title` — the file PROJECT does not move", async ({ page, context }) => {
  const { id, path } = await seed(SMALL);
  await openLive(page, context, id);
  const humanised = `Food chain ${process.pid} ${seq}`;
  await page.getByRole("button", { name: `Rename ${humanised}`, exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toHaveValue(humanised);
  await title.fill("Front Range Food Chain");
  await title.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Rename Front Range Food Chain", exact: true })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Front Range Food Chain", exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page, id)).metadata.title).toBe("Front Range Food Chain");
  const after = await stored(page, id);
  expect(after.path).toBe(path);
  expect(after.metadata.status).toBe("active");
  // A reload shows the stored title, still at the same address.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Rename Front Range Food Chain", exact: true })).toBeVisible({ timeout: 60_000 });
  expect((await stored(page, id)).path).toBe(path);
});

test("live: opening a Markdown project page without editing does not rewrite the stored body", async ({ page, context }) => {
  // Ends in a table: the shapes the editor tidies on its own (a trailing empty paragraph, table widths).
  const body = `${SMALL}\n\n- [ ] Open task\n- [x] Done task\n\n| Field | Value |\n| --- | --- |\n| Lead | **Ada** |\n`;
  const { id } = await seed(body);
  await openLive(page, context, id);
  await expect(editor(page).locator("table")).toBeVisible();
  await page.waitForTimeout(6000);
  expect((await server.note(id))?.content).toBe(body);
});

test("live: a 53,000-character Markdown project body opens, stays as stored, and takes an edit", async ({ page, context }) => {
  const body = largeMarkdown();
  expect(body.length).toBeGreaterThanOrEqual(53_000);
  const { id, path } = await seed(body);
  const started = Date.now();
  await openLive(page, context, id);
  const doc = editor(page);
  const sections = body.match(/^## Section \d+/gm)!.length;
  await expect(doc.locator("h2")).toHaveCount(sections, { timeout: 60_000 });
  console.log(`[project-pages-live] ${body.length}-char Markdown body live and rendered in ${Date.now() - started} ms`);
  await expect(doc.locator("h2").last()).toHaveText(`Section ${sections}`);
  expect(await doc.evaluate((el) => (el as HTMLElement).innerText.includes("**"))).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(6000);
  expect((await server.note(id))?.content).toBe(body);
  // An edit is saved as HTML with the whole body in it.
  await doc.locator("h1").first().click();
  await page.keyboard.press("End");
  const typed = Date.now();
  await page.keyboard.type(" (edited)");
  await expect(doc.locator("h1").first()).toContainText("(edited)");
  console.log(`[project-pages-live] typing 9 characters into it took ${Date.now() - typed} ms`);
  await expect.poll(async () => (await server.note(id))?.content ?? "", { timeout: 45_000 }).toContain("(edited)");
  const after = await stored(page, id);
  expect(after.path).toBe(path);
  for (const kept of ["Front Range Commons", `Section ${sections}`, "<strong>bold text</strong>", "Task 1.1"]) expect(after.content).toContain(kept);
});
