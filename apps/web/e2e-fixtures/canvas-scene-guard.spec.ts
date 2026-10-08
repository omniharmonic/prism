import { test, expect, type Page } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";

/**
 * A live canvas whose shared map holds elements Excalidraw 0.18 cannot render (an
 * invalid fractional `index`, a line without `points`, an element without a type) —
 * at first paint or arriving later from another client — opens and stays open: no
 * uncaught exception, no "couldn't open" card, and the CRDT entries are left as
 * they are (the canvas only paints a sanitised copy). Fixture: a local Hocuspocus
 * server behind the page's /collab socket (as lazy-editors.spec.ts).
 */
type Seed = Record<string, unknown>[];
async function collaborativeFixture(page: Page, kind: "canvas", seed: Seed) {
  let saved: Uint8Array | undefined;
  let level: "own" | "view" = "own";
  const server = new Server({ address: "127.0.0.1", port: 0, quiet: true, debounce: 10,
    async onAuthenticate({ connectionConfig }) { connectionConfig.readOnly = level === "view"; return { fixture: true }; },
    async onLoadDocument({ document }) {
      if (saved) Y.applyUpdate(document, saved);
      else for (const element of seed) document.getMap("elements").set(String(element.id), element);
      saved = Y.encodeStateAsUpdate(document);
      document.on("update", () => { saved = Y.encodeStateAsUpdate(document); });
      return document;
    },
  });
  await server.listen();
  const sockets: WebSocket[] = [];
  await page.routeWebSocket(/\/collab(\?|$)/, route => {
    const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
    const pending: (string | Buffer)[] = [];
    route.onMessage(message => socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message));
    socket.on("open", () => { for (const message of pending) socket.send(message); });
    socket.on("message", (message, binary) => route.send(binary ? Buffer.from(message as Buffer) : message.toString()));
    route.onClose(() => socket.close()); socket.on("close", () => route.close({ code: 1000 }));
  });
  await page.route("**/auth/me", route => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "lazy-workspace" } } }));
  await page.route("**/api/notes/denied-note", route => route.fulfill({ json: { id: "denied-note", path: "Lazy fixture", content: "", _level: level, metadata: { type: kind, language: "typescript" }, tags: [] } }));
  await page.route("**/api/federated/**", route => route.fulfill({ status: 204 }));
  return {
    server,
    downgrade() {
      level = "view";
      for (const doc of server.hocuspocus.documents.values()) for (const connection of doc.getConnections())
        connection.close({ code: 4403, reason: "Access changed. Reconnect to check your permissions." });
    },
    doc: () => [...server.hocuspocus.documents.values()][0]!,
    async close() { await page.goto("about:blank"); for (const socket of sockets) socket.terminate(); await server.destroy(); },
  };
}

const rect = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 50, height: 50, version: 1, versionNonce: 1, isDeleted: false, ...extra });
const BAD: Record<string, Seed> = {
  "an invalid order key": [rect("bad-index", { index: "zz" }), rect("good", { index: "a0" })],
  "a line without points": [{ id: "no-points", type: "line", x: 0, y: 0, width: 50, height: 50, version: 1, versionNonce: 1, isDeleted: false }, rect("good")],
  "an element without a type": [{ id: "no-type" }, rect("good")],
};

for (const [what, seed] of Object.entries(BAD)) {
  test(`a live canvas holding ${what} opens, and a later remote one does not break it`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const fixture = await collaborativeFixture(page, "canvas", seed);
    try {
      await page.goto("/e2e-fixtures/collab-storage.html?live");
      await expect(page.getByRole("button", { name: "Focus canvas", exact: true })).toBeVisible();
      await expect(page.getByText("Live · Editing", { exact: true })).toBeVisible();
      await expect(page.getByRole("toolbar").or(page.getByText("Shapes")).first()).toBeVisible();
      // The same kind of entry arriving from another client after the first paint (the observer's repaint).
      const map = fixture.doc().getMap("elements");
      for (const element of seed) map.set(`${String(element.id)}-later`, { ...element, id: `${String(element.id)}-later` });
      await page.waitForTimeout(800);
      await expect(page.getByText(/couldn.t open/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Focus canvas", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      // Painting deletes nothing from the shared map; what was left out of the picture is kept as it was.
      for (const element of seed) expect(map.has(String(element.id))).toBe(true);
      for (const id of ["no-points", "no-type"]) if (seed.some((e) => e.id === id)) expect(map.get(id)).toEqual(seed.find((e) => e.id === id));
    } finally { await fixture.close(); }
  });
}
