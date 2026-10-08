/**
 * "Creating a new canvas crashed; it eventually loaded" (2026-10) — against the REAL
 * Prism Server fixture (gateway + collab socket over the fake vault):
 *   - a canvas made from New page → Format → Canvas opens live, with no crash card;
 *   - the vault failing the collab load's first read is refused `busy` and retried by
 *     the page by itself — never opened as a text document / an empty canvas;
 *   - a slow or failing download of the canvas engine is retried quietly before any
 *     "couldn't open" card.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

let server: RealServer;
test.beforeAll(async ({}, info) => {
  server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
});
test.afterAll(async () => {
  await server?.stop();
});
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000); // the fixture dev server compiles the app + Excalidraw on first use

/** Console errors that mean the page crashed (renderer boundary, uncaught exceptions). */
function watchCrashes(page: Page): string[] {
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && /Renderer crashed|Collaborative editor failed/.test(m.text())) crashes.push(m.text()); });
  return crashes;
}

async function createCanvas(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Choose page type", exact: true }).first().click();
  // The dialog's name follows the chosen format ("New page" → "New canvas"): find it by its title id.
  const dialog = page.locator('[aria-labelledby="new-content-title"]');
  await dialog.locator('[aria-controls="creation-formats"]').click();
  await page.locator("#creation-formats").getByRole("button", { name: "Canvas", exact: true }).click();
  await dialog.getByLabel(/title/i).first().fill(title);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
}

const canvasReady = (page: Page) => page.getByRole("button", { name: "Focus canvas", exact: true });

test("a canvas made from the New page menu opens live with no crash card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const crashes = watchCrashes(page);
  await connect(page, page.context(), server, "owner");
  await page.goto("/e2e-fixtures/collab-route.html?app");
  await createCanvas(page, "Fresh board");
  await expect(canvasReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Live · /)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(crashes).toEqual([]);
});

test("the vault failing the first collab read: the canvas is NOT opened as a document — the page retries and gets the scene", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const crashes = watchCrashes(page);
  const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "keep-me", type: "rectangle", x: 10, y: 10, width: 80, height: 40, version: 1, versionNonce: 1, isDeleted: false, index: "a0" }], appState: {} });
  expect(await server.add({ id: "flaky-board", path: "vault/Boards/Flaky board", content: scene, metadata: { type: "canvas", title: "Flaky board" } })).toBe(true);
  await server.failReads("Flaky board", 1);
  await connect(page, page.context(), server, "owner");
  // The page's own REST reads of the note are answered here, so the ONE failing vault read is the collab load's.
  const body = { id: "flaky-board", path: "vault/Boards/Flaky board", content: scene, tags: [], metadata: { type: "canvas", title: "Flaky board" }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  await page.route(/\/api\/notes\/flaky-board(\?|$)/, (route) => route.request().method() === "GET" ? route.fulfill({ json: body }) : route.fallback());
  await page.goto("/e2e-fixtures/collab-route.html?page=flaky-board");
  await expect(canvasReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Live · /)).toBeVisible({ timeout: 15_000 });
  const state = await server.live("flaky-board");
  expect(state.remaining, "the armed read failure was spent by the collab load").toBe(0);
  expect(state.live).toEqual({ elements: 1, fragment: 0 });
  await expect(page.getByText("Reconnect to open this document.")).toHaveCount(0);
  expect(crashes).toEqual([]);
});

test("one failed download of the canvas engine is retried quietly — no 'couldn't open' card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let attempts = 0;
  await page.route(/\/CollabCanvas\.tsx/, (route) => (++attempts === 1 ? route.abort("failed") : route.continue()));
  await connect(page, page.context(), server, "owner");
  await page.goto("/e2e-fixtures/collab-route.html?app");
  await createCanvas(page, "Board after a failed download");
  await expect(canvasReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/couldn.t open/)).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(2);
});
