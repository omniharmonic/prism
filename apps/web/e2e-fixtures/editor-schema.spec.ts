import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

const SHOTS = process.env.PRISM_EDITOR_SHOTS;
/** The editor's current document-schema version (bumped with every schema change). */
const V = 4;
const REASON = "update_required: Prism was updated. Reload or update the app to keep editing.";

/** A real Hocuspocus server that enforces the schema param like the Prism Server. */
async function gatedServer(minimum: number) {
  const seen: string[] = [];
  const server = new Server({
    address: "127.0.0.1", port: 0, quiet: true, debounce: 10,
    async onAuthenticate({ requestParameters }) {
      const v = requestParameters.get("schema") ?? "";
      seen.push(v);
      if (!/^\d+$/.test(v) || Number(v) < minimum) throw Object.assign(new Error(REASON), { reason: REASON });
      return { fixture: true };
    },
  });
  await server.listen();
  return { server, seen };
}

async function openLive(page: Page, server: Server, sockets: WebSocket[], urls: string[]) {
  await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
    urls.push(route.url());
    // Forward the query so the real server sees what the client sent.
    const socket = new WebSocket(server.webSocketURL + new URL(route.url()).search); sockets.push(socket);
    const pending: (string | Buffer)[] = [];
    route.onMessage((m) => (socket.readyState === WebSocket.OPEN ? socket.send(m) : pending.push(m)));
    socket.on("open", () => { for (const m of pending) socket.send(m); });
    socket.on("message", (m, binary) => route.send(binary ? Buffer.from(m as Buffer) : m.toString()));
    route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
  });
  const headers: Array<string | null> = [];
  await page.route("**/auth/me", (r) => r.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
  await page.route("**/api/notes/denied-note", (r) => { headers.push(r.request().headers()["x-prism-editor-schema"] ?? null); return r.fulfill({ json: { id: "denied-note", path: "Projects/Prism/Shared", content: "", _level: "own", metadata: {}, tags: [] } }); });
  await page.route("**/api/federated/**", (r) => r.fulfill({ status: 204 }));
  await page.goto("/e2e-fixtures/collab-storage.html?live");
  return headers;
}

test("the live editor sends its schema version and REST calls carry the editor-schema header", async ({ page }) => {
  const { server, seen } = await gatedServer(V);
  const sockets: WebSocket[] = [];
  const urls: string[] = [];
  try {
    const headers = await openLive(page, server, sockets, urls);
    await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
    expect(urls[0]).toMatch(new RegExp(`/collab\\?schema=${V}$`));
    expect(seen[0]).toBe(String(V));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === String(V))).toBe(true);
  } finally {
    for (const s of sockets) s.close();
    await server.destroy();
  }
});

test("a server that requires a newer schema shows 'Update required' with Reload — no editor", async ({ page }) => {
  const { server } = await gatedServer(V + 1);
  const sockets: WebSocket[] = [];
  try {
    await openLive(page, server, sockets, []);
    const alert = page.getByRole("alert").filter({ hasText: "Update required" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Prism was updated. Reload or update the app to keep editing.");
    await expect(page.locator(".tiptap")).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/update-required-1280.png` });
    const reloaded = page.waitForEvent("framenavigated");
    await alert.getByRole("button", { name: "Reload" }).click();
    await reloaded;
  } finally {
    for (const s of sockets) s.close();
    await server.destroy();
  }
});
