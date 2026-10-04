import { test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Cross-browser helpers for the fixture suite (Chromium + WebKit). Nothing here changes what a
 * test asserts; it only replaces the browser-specific way a test SETS UP or DRIVES the page.
 */

/** Skip a test that drives the page through the Chrome DevTools Protocol (IME composition, CPU
 *  throttling, …) on every other engine. Call it first in the test body. */
export function chromiumOnly(browserName: string, reason: string) {
  base.skip(browserName !== "chromium", `Chromium only: ${reason}`);
}

/**
 * Let the page use the async clipboard and let the test read it back.
 *
 * Chromium: grants the real `clipboard-read` / `clipboard-write` permissions.
 * WebKit: has no such permissions (Playwright rejects the names) and refuses
 * `navigator.clipboard.readText()` outside a user gesture, so the test could never read back what
 * the product wrote. There the async clipboard API is replaced, before any page script runs, by an
 * in-memory one with the same surface (`writeText`, `write`, `readText`, `read`): the product code
 * still calls the real API names with the real arguments, and the assertions read exactly what it
 * passed. Copy/cut/paste EVENTS and `document.execCommand` are untouched.
 */
export async function grantClipboard(context: BrowserContext, browserName: string) {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    return;
  }
  const install = () => {
    if ((window as { __prismClipboardStub?: boolean }).__prismClipboardStub) return;
    (window as { __prismClipboardStub?: boolean }).__prismClipboardStub = true;
    let items: ClipboardItem[] = [];
    let text = "";
    const stub = {
      async writeText(value: string) { text = String(value); items = [new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })]; },
      async write(next: ClipboardItem[]) {
        items = Array.from(next);
        text = "";
        for (const item of items) if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      },
      async readText() { return text; },
      async read() { return items; },
    };
    // On the instance first (wins over the prototype), then the prototype, then the accessor.
    const install = (target: object | null | undefined) => {
      if (!target) return;
      for (const [name, value] of Object.entries(stub)) {
        try { Object.defineProperty(target, name, { configurable: true, writable: true, value }); } catch { /* next target */ }
      }
    };
    install(navigator.clipboard);
    install((globalThis as { Clipboard?: { prototype: object } }).Clipboard?.prototype);
    if (navigator.clipboard?.readText !== stub.readText) {
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => stub });
    }
  };
  // Later navigations, and the pages that are already open (a spec may grant after its goto).
  await context.addInitScript(install);
  for (const page of context.pages()) await page.evaluate(install).catch(() => {});
}

export interface TouchDrag {
  /** Start point, viewport coordinates. */
  x: number; y: number;
  /** Finger travel. */
  dx?: number; dy?: number;
  /** Number of touchmove events (default 8). */
  steps?: number;
  /** Leave the finger down (no touchend). */
  hold?: boolean;
  /** Whether the events are cancelable (default true). */
  cancelable?: boolean;
}

/**
 * One synthesized finger drag on the element under (x, y): touchstart, `steps` touchmoves, touchend.
 * Chromium builds the points with `new Touch()` and takes arrays; WebKit has no Touch constructor
 * ("Illegal constructor") and its TouchEvent takes only a TouchList, so there the points come from
 * `document.createTouch()` / `createTouchList()`. Both dispatch real `TouchEvent`s.
 */
export async function touchDrag(page: Page, drag: TouchDrag) {
  await page.evaluate(({ x, y, dx, dy, steps, hold, cancelable }) => {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const legacy = document as unknown as { createTouch?(...args: unknown[]): Touch; createTouchList?(...touches: Touch[]): Touch[] };
    const touch = (cx: number, cy: number): Touch => {
      try { return new Touch({ identifier: 1, target, clientX: cx, clientY: cy }); }
      // WebKit: createTouch(view, target, identifier, pageX, pageY, screenX, screenY).
      catch { return legacy.createTouch!(window, target, 1, cx + window.scrollX, cy + window.scrollY, cx, cy); }
    };
    const list = (...touches: Touch[]): Touch[] => (legacy.createTouchList ? legacy.createTouchList(...touches) : touches);
    const fire = (type: string, cx: number, cy: number, end = false) =>
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable, touches: end ? list() : list(touch(cx, cy)), changedTouches: list(touch(cx, cy)) }));
    fire("touchstart", x, y);
    for (let i = 1; i <= steps; i++) fire("touchmove", x + (dx * i) / steps, y + (dy * i) / steps);
    if (!hold) fire("touchend", x + dx, y + dy, true);
  }, { x: drag.x, y: drag.y, dx: drag.dx ?? 0, dy: drag.dy ?? 0, steps: drag.steps ?? 8, hold: !!drag.hold, cancelable: drag.cancelable ?? true });
}

/** Lift the finger a held `touchDrag` left down (a touchend with no points, on `target`). */
export const touchRelease = (target: Locator) =>
  target.evaluate((el) => {
    const legacy = document as unknown as { createTouchList?(): Touch[] };
    const none = legacy.createTouchList ? legacy.createTouchList() : [];
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: none, changedTouches: none }));
  });

/**
 * `test` for specs that walk the page with Tab.
 *
 * Safari's default is that Tab stops only at text fields and lists; buttons, links and other
 * focusable elements are reached with Option+Tab, or with plain Tab once the person turns on
 * Safari → Settings → Advanced → "Press Tab to highlight each item on a webpage" (or macOS
 * "Keyboard navigation"). Playwright cannot set that preference. On WebKit this fixture therefore
 * runs the page AS IF the preference were on: `page.keyboard.press("Tab")` / `"Shift+Tab"` are sent
 * with Option held (WebKit's native "walk everything" traversal), and a capture listener makes the
 * event read as a plain Tab (`altKey === false`) to page scripts — exactly what the product sees
 * from a person who enabled the preference. Chromium is untouched. Assertions are unchanged.
 */
export const test = base.extend({
  page: async ({ page, context, browserName }, use) => {
    if (browserName === "webkit") {
      await context.addInitScript(() => {
        const plain = (e: KeyboardEvent) => {
          if (e.key !== "Tab" || !e.altKey) return;
          const native = e.getModifierState.bind(e);
          Object.defineProperty(e, "altKey", { configurable: true, get: () => false });
          Object.defineProperty(e, "getModifierState", { configurable: true, value: (key: string) => (key === "Alt" ? false : native(key)) });
        };
        window.addEventListener("keydown", plain, true);
        window.addEventListener("keyup", plain, true);
      });
      const walk = (target: Page) => {
        const press = target.keyboard.press.bind(target.keyboard);
        target.keyboard.press = (key, options) => press(key === "Tab" ? "Alt+Tab" : key === "Shift+Tab" ? "Alt+Shift+Tab" : key, options);
      };
      walk(page);
      context.on("page", walk);
    }
    await use(page);
  },
});
export { expect } from "@playwright/test";

/** The key that moves the caret to the end of the line: `End` (Chromium's editing behaviour in
 *  Playwright) — macOS WebKit follows the platform, where End only scrolls and ⌘→ moves the caret. */
export const lineEndKey = (browserName: string) => (browserName === "webkit" ? "Meta+ArrowRight" : "End");
