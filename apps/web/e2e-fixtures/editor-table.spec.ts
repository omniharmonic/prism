import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;

/** rows × columns of the first table, plus whether its first row is a header row. */
type Shape = { rows: number; cols: number; header: boolean } | null;
const shape = (page: Page): Promise<Shape> => page.evaluate((): Shape => {
  const editor = (document.querySelector(".tiptap") as any).editor;
  let out = null as Shape;
  editor.state.doc.descendants((n: any) => {
    if (out || n.type.name !== "table") return !out;
    const first = n.firstChild;
    out = { rows: n.childCount, cols: first.childCount, header: first.firstChild.type.name === "tableHeader" };
    return false;
  });
  return out;
});

async function insertTable(page: Page) {
  await page.locator(".tiptap[contenteditable=true]").click();
  await page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
}

test("table controls add and remove rows and columns, toggle the header row and delete the table", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  await insertTable(page);
  expect(await shape(page)).toEqual({ rows: 3, cols: 3, header: true });
  const bar = page.getByRole("toolbar", { name: "Table" });
  await expect(bar).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-controls-1440.png` });
  await page.keyboard.type("Name");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Role");
  await bar.getByRole("button", { name: "Add row below" }).click();
  expect(await shape(page)).toEqual({ rows: 4, cols: 3, header: true });
  await bar.getByRole("button", { name: "Add column right" }).click();
  expect(await shape(page)).toEqual({ rows: 4, cols: 4, header: true });
  await page.keyboard.press("ArrowDown"); // into the first body row
  await bar.getByRole("button", { name: "Add row above" }).click();
  await bar.getByRole("button", { name: "Add column left" }).click();
  expect(await shape(page)).toEqual({ rows: 5, cols: 5, header: true });
  await bar.getByRole("button", { name: "Delete row" }).click();
  await bar.getByRole("button", { name: "Delete column" }).click();
  expect(await shape(page)).toEqual({ rows: 4, cols: 4, header: true });
  await bar.getByRole("button", { name: "Toggle header row" }).click();
  expect((await shape(page))!.header).toBe(false);
  await bar.getByRole("button", { name: "Toggle header row" }).click();
  expect((await shape(page))!.header).toBe(true);
  // The reshaped table (4 × 4, header row, typed text in a surviving column) is saved.
  const saved = () => page.evaluate(() => (window as any).prismBlockWrites.at(-1)?.content ?? "");
  await expect.poll(saved, { timeout: 6000 }).toMatch(/<table[\s\S]*<\/table>/);
  const table = (await saved()).match(/<table[\s\S]*<\/table>/)![0];
  expect(table.match(/<tr>/g)).toHaveLength(4);
  expect(table.match(/<th /g)).toHaveLength(4);
  expect(table).toMatch(/<p>(Name|Role)<\/p><\/th>/);
  await bar.getByRole("button", { name: "Delete table" }).click();
  expect(await shape(page)).toBeNull();
  await expect(bar).toHaveCount(0);
});

test("table controls stay hidden for read-only documents and fit a phone", async ({ page }) => {
  await page.goto("/e2e-fixtures/editor-blocks.html?readonly&content=" + encodeURIComponent("<table><tbody><tr><th><p>A</p></th></tr><tr><td><p>B</p></td></tr></tbody></table>"));
  await page.getByText("B", { exact: true }).click();
  await page.waitForTimeout(150);
  await expect(page.getByRole("toolbar", { name: "Table" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/editor-blocks.html");
  await insertTable(page);
  const bar = page.getByRole("toolbar", { name: "Table" });
  const box = await bar.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-controls-390.png` });
});

test("live editor: tables, callouts, toggles and columns reach the other client intact", async ({ browser }) => {
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage((m) => (socket.readyState === WebSocket.OPEN ? socket.send(m) : pending.push(m)));
      socket.on("open", () => { for (const m of pending) socket.send(m); });
      socket.on("message", (m, binary) => route.send(binary ? Buffer.from(m as Buffer) : m.toString()));
      route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
    });
    await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note", (r) => r.fulfill({ json: { id: "denied-note", path: "Projects/Prism/Shared", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (r) => r.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    return { context, page };
  };
  try {
    const a = await open();
    await a.page.locator(".tiptap[contenteditable=true]").click();
    await a.page.keyboard.type("Intro");
    for (const [query, text] of [["callout", "Careful"], ["toggle", "More"], ["2col", "Left"], ["table", "Cell"]] as const) {
      await a.page.evaluate(() => (document.querySelector(".tiptap") as any).editor.commands.focus("end"));
      await a.page.keyboard.press("Enter");
      await a.page.keyboard.type(`/${query}`);
      await a.page.keyboard.press("Enter");
      await a.page.keyboard.type(text);
    }
    await expect(a.page.getByRole("toolbar", { name: "Table" })).toBeVisible();
    await a.page.getByRole("toolbar", { name: "Table" }).getByRole("button", { name: "Add row below" }).click();
    const b = await open();
    const html = (p: Page) => p.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
    await expect.poll(() => html(b.page)).toBe(await html(a.page));
    const out = await html(b.page);
    expect(out).toMatch(/data-type="callout"><p>Careful<\/p>/);
    expect(out).toMatch(/<details data-type="toggle"><summary>More<\/summary>/);
    expect(out).toMatch(/data-type="columns" data-count="2"><div data-type="column"><p>Left<\/p>/);
    expect(out).toMatch(/<th[^>]*><p>Cell<\/p><\/th>/);
    expect((out.match(/<tr>/g) ?? []).length).toBe(4);
    if (SHOTS) await b.page.screenshot({ path: `${SHOTS}/collab-blocks-1280.png`, fullPage: true });
    await a.context.close(); await b.context.close();
  } finally {
    for (const s of sockets) s.close();
    await server.destroy();
  }
});
