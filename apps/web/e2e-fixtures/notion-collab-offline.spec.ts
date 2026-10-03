import { test, expect } from "@playwright/test";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";

/** Wave 2E re-review M1: live-document edits made while the socket is down are
 *  never under a "Saved" badge once the tab moves on, and sync by themselves on reconnect. */
test("collab offline → switch tab → reconnect: the edits are flagged, then synced in the background", async ({ page }) => {
  let serverText = "";
  const server = new Server({
    address: "127.0.0.1", port: 0, quiet: true, debounce: 10,
    async onAuthenticate() { return { fixture: true }; },
    async onChange({ document }) { serverText = document.getXmlFragment("default").toString(); },
  });
  await server.listen();
  const sockets: WebSocket[] = [];
  let up = true;
  try {
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      if (!up) { void route.close({ code: 1006 }); return; }
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage((message) => (socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message)));
      socket.on("open", () => { for (const message of pending) socket.send(message); });
      socket.on("message", (message, binary) => { try { route.send(binary ? Buffer.from(message as Buffer) : message.toString()); } catch { /* page moved on */ } });
      route.onClose(() => socket.close()); socket.on("close", () => { void route.close({ code: 1000 }).catch(() => undefined); });
    });
    await page.route("**/auth/me", (route) => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note**", (route) => route.fulfill({ json: { id: "denied-note", path: "Projects/Live page", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (route) => route.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("Synced while online.");
    await expect.poll(() => serverText, { timeout: 10000 }).toContain("Synced while online.");
    expect(await page.evaluate(() => (window as any).prismCollabFixture.unsynced())).toEqual([]);

    // The socket drops (server restart / tunnel hiccup) while the browser still says "online".
    up = false;
    for (const socket of sockets.splice(0)) socket.close();
    await expect(page.getByText(/Connecting…|Offline/).first()).toBeVisible({ timeout: 10000 });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Typed while disconnected.");
    await expect.poll(async () => ((await page.evaluate(() => (window as any).prismCollabFixture.unsynced())) as unknown[]).length, { timeout: 10000 }).toBe(1);
    expect(serverText).not.toContain("Typed while disconnected.");
    // Leave only once the device really holds the edit. The local write is asynchronous
    // (the badge reads "Saving…" until it lands); navigating a few ms after the last
    // keystroke used to drop the IndexedDB transaction, and nothing was left to sync.
    const localTexts = () => page.evaluate(() => (window as any).prismCollabFixture.localTexts()) as Promise<string[]>;
    await expect.poll(async () => (await localTexts()).join("\n"), { timeout: 10000 }).toContain("Typed while disconnected.");
    await expect.poll(() => page.evaluate(() => (window as any).prismCollabFixture.syncLabel())).toBe("Offline · changes saved on this device");

    // "Switch tab": the document is no longer open. The badge must not say Saved.
    await page.goto("/e2e-fixtures/collab-storage.html");
    await expect(page.getByText("Scoped collaborative storage fixture")).toBeVisible();
    await page.evaluate(() => (window as any).prismCollabFixture.checkAuth());
    // The edit survived the reload on this device (a registry entry alone proves nothing).
    expect((await localTexts()).join("\n")).toContain("Typed while disconnected.");
    await page.evaluate(() => (window as any).prismCollabFixture.startUnsynced());
    await expect.poll(() => page.evaluate(() => (window as any).prismCollabFixture.syncLabel())).toBe("Changes on this device — will sync");
    // While the server is still unreachable nothing is lost and nothing is cleared.
    await page.evaluate(() => (window as any).prismCollabFixture.syncUnsynced());
    expect(((await page.evaluate(() => (window as any).prismCollabFixture.unsynced())) as unknown[]).length).toBe(1);

    // Reconnect: synced headlessly, registry cleared, badge back to Saved.
    up = true;
    await expect.poll(async () => { await page.evaluate(() => (window as any).prismCollabFixture.syncUnsynced()); return serverText; }, { timeout: 30000, intervals: [1000] }).toContain("Typed while disconnected.");
    await expect.poll(async () => ((await page.evaluate(() => (window as any).prismCollabFixture.unsynced())) as unknown[]).length, { timeout: 10000 }).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as any).prismCollabFixture.syncLabel())).toBe("Saved");
    expect(serverText).toContain("Synced while online.");
  } finally {
    for (const socket of sockets) socket.close();
    await server.destroy();
  }
});

/** Wave 3 unload guard: keystrokes typed IMMEDIATELY before leaving, with the socket
 *  down, survive — the part IndexedDB had not confirmed is written synchronously on
 *  pagehide, the document is registered as unsynced, and it syncs on reconnect. */
test("collab offline → type → leave at once: the last keystrokes survive and sync", async ({ page }) => {
  let serverText = "";
  const server = new Server({
    address: "127.0.0.1", port: 0, quiet: true, debounce: 10,
    async onAuthenticate() { return { fixture: true }; },
    async onChange({ document }) { serverText = document.getXmlFragment("default").toString(); },
  });
  await server.listen();
  const sockets: WebSocket[] = [];
  let up = true;
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.type()); void dialog.accept(); });
  try {
    await page.routeWebSocket(/\/collab(\?|$)/, (route) => {
      if (!up) { void route.close({ code: 1006 }); return; }
      const socket = new WebSocket(server.webSocketURL); sockets.push(socket);
      const pending: (string | Buffer)[] = [];
      route.onMessage((message) => (socket.readyState === WebSocket.OPEN ? socket.send(message) : pending.push(message)));
      socket.on("open", () => { for (const message of pending) socket.send(message); });
      socket.on("message", (message, binary) => { try { route.send(binary ? Buffer.from(message as Buffer) : message.toString()); } catch { /* page moved on */ } });
      route.onClose(() => socket.close()); socket.on("close", () => { void route.close({ code: 1000 }).catch(() => undefined); });
    });
    await page.route("**/auth/me", (route) => route.fulfill({ json: { authenticated: true, email: "alice@example.test", vaultId: "primary", workspace: { id: "workspace-a" } } }));
    await page.route("**/api/notes/denied-note**", (route) => route.fulfill({ json: { id: "denied-note", path: "Projects/Live page", content: "", _level: "own", metadata: {}, tags: [] } }));
    await page.route("**/api/federated/**", (route) => route.fulfill({ status: 204 }));
    await page.goto("/e2e-fixtures/collab-storage.html?live");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("Synced while online.");
    await expect.poll(() => serverText, { timeout: 10000 }).toContain("Synced while online.");
    // Online and synced: leaving needs no warning.
    expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(false);

    up = false;
    for (const socket of sockets.splice(0)) socket.close();
    await expect(page.getByText(/Connecting…|Offline/).first()).toBeVisible({ timeout: 10000 });
    // An edit and, in the same task, the browser's leave check: the local write cannot
    // have been confirmed yet, so the page asks before leaving …
    const warned = await page.evaluate(() => {
      const view = document.querySelector(".tiptap") as HTMLElement & { editor: { commands: { insertContent: (text: string) => boolean; focus: (at: string) => boolean } } };
      view.editor.commands.focus("end");
      view.editor.commands.insertContent(" Last words before leaving.");
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      // … and the page goes away at once (no wait for IndexedDB).
      window.dispatchEvent(new Event("pagehide"));
      return { prevented: e.defaultPrevented, rescued: (window as any).prismCollabFixture.rescued() as number };
    });
    expect(warned.prevented).toBe(true);
    expect(warned.rescued).toBe(1);
    expect((await page.evaluate(() => (window as any).prismCollabFixture.deviceTexts()) as string[]).join("\n")).toContain("Last words before leaving.");
    // Real keystrokes, then navigate without waiting for anything.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Typed at the door.", { delay: 0 });
    await page.goto("/e2e-fixtures/collab-storage.html");
    await expect(page.getByText("Scoped collaborative storage fixture")).toBeVisible();
    expect(serverText).not.toContain("Typed at the door.");
    await page.evaluate(() => (window as any).prismCollabFixture.checkAuth());
    // On this device: in IndexedDB, or in the synchronous rescue entry.
    const held = ((await page.evaluate(() => (window as any).prismCollabFixture.deviceTexts())) as string[]).join("\n");
    expect(held).toContain("Last words before leaving.");
    expect(held).toContain("Typed at the door.");
    expect(((await page.evaluate(() => (window as any).prismCollabFixture.unsynced())) as unknown[]).length).toBe(1);

    up = true;
    await page.evaluate(() => (window as any).prismCollabFixture.startUnsynced());
    await expect.poll(async () => { await page.evaluate(() => (window as any).prismCollabFixture.syncUnsynced()); return serverText; }, { timeout: 30000, intervals: [1000] }).toContain("Typed at the door.");
    expect(serverText).toContain("Last words before leaving.");
    expect(serverText).toContain("Synced while online.");
    await expect.poll(async () => ((await page.evaluate(() => (window as any).prismCollabFixture.unsynced())) as unknown[]).length, { timeout: 10000 }).toBe(0);
    // The rescue entry is folded into IndexedDB and removed.
    await expect.poll(() => page.evaluate(() => (window as any).prismCollabFixture.rescued())).toBe(0);
  } finally {
    for (const socket of sockets) socket.close();
    await server.destroy();
  }
});
