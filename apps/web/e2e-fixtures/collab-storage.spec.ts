import { test, expect } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

test("collaborative drafts survive reload and remain isolated by account, vault, workspace, server and document", async ({ page }) => {
  await page.goto("/e2e-fixtures/collab-storage.html");
  expect(await page.evaluate(() => (window as any).prismCollabFixture.open("original"))).toBe("");
  expect(await page.evaluate(() => (window as any).prismCollabFixture.append("original", "Private offline change"))).toBe("saved");
  await page.reload();
  expect(await page.evaluate(() => (window as any).prismCollabFixture.open("restored"))).toBe("Private offline change");
  for (const override of [{ actor: "user:bob@example.test" }, { vault: "vault-b" }, { workspace: "workspace-b" }, { api: "https://other.example.test/api" }]) {
    expect(await page.evaluate((override) => (window as any).prismCollabFixture.open("other", override), override)).toBe("");
    await page.evaluate(() => (window as any).prismCollabFixture.close("other"));
  }
  expect(await page.evaluate(() => (window as any).prismCollabFixture.open("other-note", {}, "another-note"))).toBe("");
});

test("two offline documents cannot overwrite each other's saved changes", async ({ page, context }) => {
  await page.goto("/e2e-fixtures/collab-storage.html");
  const second = await context.newPage();
  await second.goto("/e2e-fixtures/collab-storage.html");
  await Promise.all([page, second].map(p => p.evaluate(() => (window as any).prismCollabFixture.open("draft"))));
  await Promise.all([
    page.evaluate(() => (window as any).prismCollabFixture.append("draft", "FIRST")),
    second.evaluate(() => (window as any).prismCollabFixture.append("draft", "SECOND")),
  ]);
  await second.close();
  await page.reload();
  const restored = await page.evaluate(() => (window as any).prismCollabFixture.open("combined"));
  expect(restored).toContain("FIRST");
  expect(restored).toContain("SECOND");
});

test("denied document never opens local collaborative storage or a socket", async ({ page }) => {
  let sockets = 0;
  page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/collab") sockets++; });
  await page.route("**/auth/me", route => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "vault-a", workspace: { id: "workspace-a" } } }));
  await page.route("**/api/notes/denied-note", route => route.fulfill({ status: 403, json: { error: "Forbidden" } }));
  await page.goto("/e2e-fixtures/collab-storage.html?denied");
  await expect(page.getByRole("heading", { name: "Request access" })).toBeVisible();
  expect(sockets).toBe(0);
  expect(await page.evaluate(async () => (await indexedDB.databases()).filter(db => db.name?.startsWith("prism-collab")))).toEqual([]);
});

test("failed access checks report a connection problem while a rejected session reports sign-out", async ({ page }) => {
  await page.goto("/e2e-fixtures/collab-storage.html?reconnect");
  await expect(page.getByRole("heading", { name: "Reconnect to your workspace" })).toBeVisible();
  await page.route("**/auth/me", route => route.abort("internetdisconnected"));
  expect(await page.evaluate(() => (window as any).prismCollabFixture.checkAuth())).toEqual({ authenticated: false, unavailable: true });
  await page.unroute("**/auth/me");
  await page.route("**/auth/me", route => route.fulfill({ status: 503 }));
  expect(await page.evaluate(() => (window as any).prismCollabFixture.checkAuth())).toEqual({ authenticated: false, unavailable: true });
  await page.unroute("**/auth/me");
  await page.route("**/auth/me", route => route.fulfill({ status: 401 }));
  expect(await page.evaluate(() => (window as any).prismCollabFixture.checkAuth())).toEqual({ authenticated: false });
});

test("real collaborative editor survives StrictMode and reload with scoped durable edits", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10, async onAuthenticate() { return { fixture: true }; } });
  await server.listen();
  const sockets: WebSocket[] = [];
  try {
    await page.routeWebSocket(/\/collab$/, route => {
      const socket = new WebSocket(server.webSocketURL);
      sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
      socket.on("open", () => { for (const message of pending) socket.send(message); });
      socket.on("message", (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
      route.onClose(() => socket.close());
    });
    await page.route("**/auth/me", route => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note", route => route.fulfill({ json: { id: "denied-note", path: "Private fixture", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", route => route.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
    await page.locator(".tiptap[contenteditable=true]").fill("SCOPED_CRDT_EDIT");
    await expect.poll(async () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("prism-collab-v3"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { const r = db.transaction("documents").objectStore("documents").getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      db.close();
      return keys.length;
    })).toBe(1);
    await page.reload();
    await expect(page.locator(".tiptap")).toHaveText("SCOPED_CRDT_EDIT");
    expect(errors).toEqual([]);
    await page.goto("about:blank");
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.destroy();
  }
});

test("a disk failure never reports an offline edit as saved", async ({ page }) => {
  await page.goto("/e2e-fixtures/collab-storage.html");
  await page.evaluate(() => (window as any).prismCollabFixture.open("draft"));
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      if (this.name === "prism-collab-v3" && args[1] === "readwrite") throw new DOMException("Fixture quota", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  expect(await page.evaluate(() => (window as any).prismCollabFixture.append("draft", "UNSAVED_FIXTURE"))).toBe("unavailable");
});
