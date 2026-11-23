/**
 * Every clipboard write runs inside the user's gesture, has a real fallback and reports honestly.
 *
 * WebKit (Safari, and the Prism Client's WKWebView) refuses `navigator.clipboard.writeText()` once
 * an `await` has passed since the click — e.g. after the server created the share link. The tests
 * here replace the clipboard with one that is STRICTER than any browser (`strictClipboard`): a
 * write is accepted only while the click is still being dispatched, and `document.execCommand`
 * always answers false, so "Copied" can only come from a write that was opened synchronously in
 * the handler (`copyText`, packages/core/src/lib/clipboard.ts).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const LINK = "https://prism.example.test/private?fixture=2";

type Clip = {
  gesture: boolean;
  refuseAll: boolean;
  /** Text that reached the clipboard, with the API that carried it. */
  writes: Array<{ via: "writeText" | "write"; text: string }>;
  /** Attempts that were refused. */
  refused: string[];
};
const clip = (page: Page) => page.evaluate(() => (window as unknown as { prismClip: Clip }).prismClip);

/** Before any page script: a clipboard that only accepts a write made while a click / key press is being dispatched. */
async function strictClipboard(page: Page, options: { refuseAll?: boolean; noClipboardItem?: boolean } = {}) {
  await page.addInitScript((opts) => {
    const state = { gesture: false, refuseAll: !!opts.refuseAll, writes: [] as Array<{ via: string; text: string }>, refused: [] as string[] };
    (window as unknown as { prismClip: typeof state }).prismClip = state;
    // Live from the capture phase at the window to the end of the same dispatch (the bubble phase
    // at the window, which runs after React's root listener). The timeout covers a stopped event.
    for (const type of ["click", "keydown"]) {
      window.addEventListener(type, () => { state.gesture = true; setTimeout(() => { state.gesture = false; }, 0); }, true);
      window.addEventListener(type, () => { state.gesture = false; }, false);
    }
    const denied = (what: string) => {
      state.refused.push(what);
      return Promise.reject(new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError"));
    };
    const stub = {
      writeText(text: string) {
        if (state.refuseAll || !state.gesture) return denied("writeText");
        state.writes.push({ via: "writeText", text: String(text) });
        return Promise.resolve();
      },
      write(items: ClipboardItem[]) {
        if (state.refuseAll || !state.gesture) return denied("write");
        // Accepted inside the gesture; the item's text may still be on its way (the promise form).
        return (async () => {
          for (const item of items) state.writes.push({ via: "write", text: await (await item.getType("text/plain")).text() });
        })();
      },
    };
    Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => stub });
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => stub });
    document.execCommand = () => { state.refused.push("execCommand"); return false; };
    if (opts.noClipboardItem) Object.defineProperty(window, "ClipboardItem", { configurable: true, value: undefined });
  }, options);
}

async function openLinkAccess(page: Page) {
  await page.goto("/e2e-fixtures/sharing.html");
  await page.getByRole("button", { name: "Share fixture", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share document" })).toBeVisible();
  await expect(page.getByText("A calmer place to think", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Link access", exact: true }).click();
}

/** Click "Create link" while the fixture server holds the request, then let it answer a moment later. */
async function createLinkSlowly(page: Page) {
  await page.evaluate(() => { (window as any).prismSharingFixture.hold = true; });
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismSharingFixture.calls.some((c: any) => c.kind === "createLink"))).toBe(true);
  // Well past the click: any write that starts now is outside the gesture.
  await page.waitForTimeout(150);
  expect((await clip(page)).gesture).toBe(false);
  await page.evaluate(() => { const f = (window as any).prismSharingFixture; f.hold = false; f.release(); });
}

test("share link created on the server is copied inside the click that asked for it", async ({ page }) => {
  await strictClipboard(page);
  await openLinkAccess(page);
  await createLinkSlowly(page);
  await expect(page.getByTestId("share-copy-status")).toHaveText("link new-link copied");
  await expect(page.getByRole("button", { name: "Copy link new-link", exact: true })).toHaveText(/Copied/);
  const state = await clip(page);
  expect(state.writes).toEqual([{ via: "write", text: LINK }]);
  expect(state.refused).toEqual([]);
  await expect(page.getByText("Clipboard unavailable", { exact: false })).toHaveCount(0);

  // A link that already exists: plain text, written synchronously.
  await expect(page.getByTestId("share-copy-status")).toHaveText("", { timeout: 5000 });
  await page.getByRole("button", { name: "Copy link new-link", exact: true }).click();
  await expect(page.getByTestId("share-copy-status")).toHaveText("link new-link copied");
  expect((await clip(page)).writes).toEqual([{ via: "write", text: LINK }, { via: "writeText", text: LINK }]);
});

test("a refused clipboard never says Copied and shows the link to copy by hand", async ({ page }) => {
  await strictClipboard(page, { refuseAll: true });
  await openLinkAccess(page);
  await createLinkSlowly(page);
  const manual = page.getByLabel("link new-link", { exact: true });
  await expect(manual).toHaveValue(LINK);
  await expect(page.getByText("Clipboard unavailable. Select and copy this link.", { exact: false })).toBeVisible();
  await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("share-copy-status")).toHaveText("");
  const state = await clip(page);
  expect(state.writes).toEqual([]);
  // Everything was tried: the promise form in the click, then the text itself, then the legacy command.
  expect(state.refused).toEqual(["write", "writeText", "execCommand"]);

  // The existing link's Copy button is just as honest.
  await page.getByRole("button", { name: "Copy link new-link", exact: true }).click();
  await expect.poll(async () => (await clip(page)).refused.length).toBe(5);
  await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  await expect(manual).toHaveValue(LINK);
});

test("where the promise form is missing, a link that arrives after the click is shown, not claimed", async ({ page }) => {
  // No ClipboardItem (an old web view): the write can only start after the server answered, which
  // this clipboard — like WebKit — refuses. The UI must then offer the link, never "Copied".
  await strictClipboard(page, { noClipboardItem: true });
  await openLinkAccess(page);
  await createLinkSlowly(page);
  await expect(page.getByLabel("link new-link", { exact: true })).toHaveValue(LINK);
  await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  expect((await clip(page)).writes).toEqual([]);
  // Synchronous text still works there.
  await page.getByRole("button", { name: "Copy link new-link", exact: true }).click();
  await expect(page.getByTestId("share-copy-status")).toHaveText("link new-link copied");
  expect((await clip(page)).writes).toEqual([{ via: "writeText", text: LINK }]);
});

test("copyText: never throws, and the legacy fallback puts focus and selection back", async ({ page }) => {
  await page.goto("/e2e-fixtures/harness.html");
  const module = `/@fs${path.resolve(here, "../../../packages/core/src/lib/clipboard.ts").split(path.sep).join("/")}`;
  const result = await page.evaluate(async (url) => {
    const { copyText } = (await import(/* @vite-ignore */ url)) as { copyText: (text: string | Promise<string>) => Promise<boolean> };
    const input = document.createElement("input");
    input.value = "keep my selection";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(5, 7);

    // No async clipboard at all (an insecure origin, an old web view): the legacy command copies.
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => undefined });
    const seen: Array<{ command: string; selected: string; readOnly: boolean }> = [];
    let answer = true;
    document.execCommand = (command: string) => {
      const field = document.activeElement as HTMLTextAreaElement;
      seen.push({ command, selected: field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0), readOnly: field.readOnly });
      return answer;
    };
    const legacy = await copyText("line one\nline two");
    const afterLegacy = { focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, leftovers: document.querySelectorAll("textarea").length };
    answer = false;
    const legacyRefused = await copyText("x");
    document.execCommand = () => { throw new Error("no such command"); };
    const legacyThrows = await copyText("x");

    // A text promise that fails resolves false — with and without the promise form.
    const rejected = await copyText(Promise.reject(new Error("server said no")));
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => ({
      writeText: async (text: string) => { writes.push(`writeText:${text}`); },
      write: async (items: ClipboardItem[]) => { writes.push(`write:${await (await items[0]!.getType("text/plain")).text()}`); },
    }) });
    const rejectedWithApi = await copyText(Promise.reject(new Error("server said no")));
    const pending = await copyText(new Promise<string>((resolve) => setTimeout(() => resolve("later"), 30)));
    const now = await copyText("now");
    return { legacy, seen, afterLegacy, legacyRefused, legacyThrows, rejected, rejectedWithApi, pending, now, writes };
  }, module);
  expect(result.legacy).toBe(true);
  expect(result.seen[0]).toEqual({ command: "copy", selected: "line one\nline two", readOnly: true });
  expect(result.afterLegacy).toEqual({ focused: true, start: 5, end: 7, leftovers: 0 });
  expect(result.legacyRefused).toBe(false);
  expect(result.legacyThrows).toBe(false);
  expect(result.rejected).toBe(false);
  expect(result.rejectedWithApi).toBe(false);
  expect(result.pending).toBe(true);
  expect(result.now).toBe(true);
  expect(result.writes).toEqual(["write:later", "writeText:now"]);
});

test("guard: check-clipboard passes on the tree and catches a direct clipboard write", async ({}, info) => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const script = path.join(here, "..", "scripts", "check-clipboard.mjs");
  const clean = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(clean.status, clean.stderr).toBe(0);
  const dir = info.outputPath("clipboard-guard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "bare.ts"), "export const copy = (x: string) => navigator.clipboard.writeText(x);\n");
  writeFileSync(path.join(dir, "more.tsx"), 'export const a = async (x: string, items: ClipboardItem[]) => {\n  await navigator.clipboard?.write(items);\n  const { clipboard } = navigator;\n  await clipboard.writeText(x);\n  const w = window.navigator.clipboard["writeText"];\n  return document.execCommand("copy") || w;\n};\n');
  writeFileSync(path.join(dir, "fine.ts"), '// navigator.clipboard.writeText(x) in a comment\nexport const s = "document.execCommand(\\"copy\\")";\nexport const read = () => navigator.clipboard.readText();\nexport const pasted = (e: ClipboardEvent) => e.clipboardData?.getData("text/plain");\nexport const out = (stream: { write(x: string): void }) => stream.write("x");\n');
  const dirty = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  expect(dirty.status).toBe(1);
  expect(dirty.stderr).toContain("bare.ts:1");
  expect(dirty.stderr).toContain("copyText");
  for (const at of ["more.tsx:2", "more.tsx:4", "more.tsx:5", "more.tsx:6"]) expect(dirty.stderr).toContain(at);
  expect(dirty.stderr.match(/^ {2}\S/gm)?.length).toBe(5);
  expect(dirty.stderr).not.toContain("fine.ts");
});
