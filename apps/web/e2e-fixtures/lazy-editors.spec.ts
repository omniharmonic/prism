import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";

async function collaborativeFixture(page: Page, kind: "code" | "spreadsheet" | "canvas" | "document") {
  let saved: Uint8Array | undefined;
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10,
    async onLoadDocument({ document }) {
      if (saved) Y.applyUpdate(document, saved);
      else if (kind === "code") document.getText("codemirror").insert(0, "// LAZY_CODE_BASE");
      else if (kind === "spreadsheet") {
        for (const values of [["Name", "Status"], ["LAZY_SHEET_BASE", "Open"]]) {
          const row = new Y.Array<string>(); row.insert(0, values);
          document.getArray("rows").push([row]);
        }
      }
      saved = Y.encodeStateAsUpdate(document);
      document.on("update", () => { saved = Y.encodeStateAsUpdate(document); });
      return document;
    },
  });
  await server.listen();
  const sockets: WebSocket[] = [];
  await page.routeWebSocket(/\/collab$/, route => {
    const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
    const pending: (string | Buffer)[] = [];
    route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
    socket.on("open", () => { for (const message of pending) socket.send(message); });
    socket.on("message", (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
    route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
  });
  await page.route("**/auth/me", route => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "lazy-workspace" } } }));
  await page.route("**/api/notes/denied-note", route => route.fulfill({ json: { id: "denied-note", path: "Lazy fixture", content: "", _level: "own", metadata: { type: kind, language: "typescript" }, tags: [] } }));
  await page.route("**/api/federated/**", route => route.fulfill({ status: 204 }));
  return {
    server,
    doc: () => [...server.hocuspocus.documents.values()][0]!,
    async close() { await page.goto("about:blank"); for (const socket of sockets) socket.terminate(); await server.destroy(); },
  };
}

test("prose startup requests none of the specialized collaborative editing engines", async ({ page }) => {
  const engines: string[] = [];
  page.on("request", request => { if (/\/Collab(Canvas|CodeEditor|Spreadsheet)\.tsx/.test(request.url())) engines.push(request.url()); });
  const fixture = await collaborativeFixture(page, "document");
  try {
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
    expect(engines).toEqual([]);
  } finally { await fixture.close(); }
});

test("a delayed code engine retains its live session and receives remote edits before opening", async ({ page }) => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/CollabCodeEditor.tsx*", async route => { await blocked; await route.continue(); });
  const fixture = await collaborativeFixture(page, "code");
  try {
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.getByRole("status")).toHaveText("Loading code editor…");
    await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
    const doc = fixture.doc();
    doc.getText("codemirror").insert(doc.getText("codemirror").length, "\n// REMOTE_DURING_LOAD");
    const connections = [...doc.getConnections()];
    release();
    const editor = page.locator(".cm-content[contenteditable=true]");
    await expect(editor).toContainText("REMOTE_DURING_LOAD");
    expect([...doc.getConnections()]).toEqual(connections);
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially(" LOCAL_LAZY_EDIT");
    await expect.poll(() => doc.getText("codemirror").toString()).toContain("LOCAL_LAZY_EDIT");
    await page.reload();
    await expect(editor).toContainText("LOCAL_LAZY_EDIT");
    await expect(editor).toContainText("REMOTE_DURING_LOAD");
  } finally { release(); await fixture.close(); }
});

test("a failed sheet import offers explicit reload and preserves remote cells", async ({ page }) => {
  let attempts = 0;
  await page.route("**/CollabSpreadsheet.tsx*", route => ++attempts === 1 ? route.abort("failed") : route.continue());
  const fixture = await collaborativeFixture(page, "spreadsheet");
  try {
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.getByRole("alert")).toContainText("spreadsheet couldn’t open");
    await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
    const doc = fixture.doc();
    const connections = [...doc.getConnections()];
    const row = doc.getArray<Y.Array<string>>("rows").get(1);
    doc.transact(() => { row.delete(1, 1); row.insert(1, ["REMOTE_DURING_RETRY"]); });
    expect([...doc.getConnections()]).toEqual(connections);
    await page.getByRole("button", { name: "Reload Prism" }).click();
    await expect(page.locator('input[value="REMOTE_DURING_RETRY"]')).toBeVisible();
    const restoredRow = fixture.doc().getArray<Y.Array<string>>("rows").get(1);
    await page.locator('input[value="LAZY_SHEET_BASE"]').fill("LOCAL_SHEET_EDIT");
    await expect.poll(() => restoredRow.get(0)).toBe("LOCAL_SHEET_EDIT");
    await page.reload();
    await expect(page.locator('input[value="LOCAL_SHEET_EDIT"]')).toBeVisible();
  } finally { await fixture.close(); }
});

test("the deferred canvas opens with its own tools and keeps the live connection in focus mode", async ({ page }) => {
  const fixture = await collaborativeFixture(page, "canvas");
  try {
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.getByRole("button", { name: "Focus canvas", exact: true })).toBeVisible();
    await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
    const connections = [...fixture.doc().getConnections()];
    await page.getByRole("button", { name: "Focus canvas", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Focused canvas" })).toBeVisible();
    await page.getByRole("button", { name: "Back to document", exact: true }).click();
    expect([...fixture.doc().getConnections()]).toEqual(connections);
  } finally { await fixture.close(); }
});
