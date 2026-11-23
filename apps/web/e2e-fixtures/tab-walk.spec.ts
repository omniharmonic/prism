import { test, expect, type Page } from "@playwright/test";

/**
 * `walkTab` (packages/core/src/lib/a11y/tabWalk.ts) — review fixes:
 *  - a Tab keydown that belongs to an IME composition is never taken;
 *  - a stop that refuses focus (a control inside `<fieldset disabled>`) is stepped over, and the key is
 *    consumed only when focus really moved.
 */
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");
const last = (page: Page) => page.evaluate(() => (window as any).tabWalkLog.at(-1) as { handled: boolean; prevented: boolean });
async function open(page: Page) {
  await page.goto("/e2e-fixtures/tab-walk.html");
  await page.waitForFunction(() => (window as any).tabWalkReady === true);
}
/** A Tab keydown as the page would see it mid-composition (not a real key press: the browser does not move focus). */
interface TabInit { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }
const dispatchTab = (page: Page, init: TabInit) =>
  page.evaluate(({ keyCode, ...options }: TabInit) => {
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...options });
    if (keyCode !== undefined) Object.defineProperty(e, "keyCode", { get: () => keyCode });
    document.activeElement!.dispatchEvent(e);
  }, init);

test("walkTab skips a stop that cannot take focus and consumes the key only when focus moved", async ({ page }) => {
  await open(page);
  await page.locator("#a").focus();
  // Forward: A → C (B is in a disabled fieldset, the hidden button is no stop) → D → the browser's.
  await dispatchTab(page, {});
  expect(await focused(page)).toBe("c");
  expect(await last(page)).toEqual({ handled: true, prevented: true });
  await dispatchTab(page, {});
  expect(await focused(page)).toBe("d");
  await dispatchTab(page, {});
  expect(await focused(page)).toBe("d"); // the last stop: nothing to move to, the key is left alone
  expect(await last(page)).toEqual({ handled: false, prevented: false });
  // Back: D → C → A (over B again) → the browser's.
  await dispatchTab(page, { shiftKey: true });
  expect(await focused(page)).toBe("c");
  await dispatchTab(page, { shiftKey: true });
  expect(await focused(page)).toBe("a");
  expect(await last(page)).toEqual({ handled: true, prevented: true });
  await dispatchTab(page, { shiftKey: true });
  expect(await focused(page)).toBe("a");
  expect(await last(page)).toEqual({ handled: false, prevented: false });
  // A real Tab walks the same way.
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("c");
});

test("walkTab leaves a Tab that belongs to an IME composition alone", async ({ page }) => {
  await open(page);
  await page.locator("#a").focus();
  await dispatchTab(page, { isComposing: true });
  expect(await focused(page)).toBe("a");
  expect(await last(page)).toEqual({ handled: false, prevented: false });
  // The older signal: keyCode 229 ("Process") while composing.
  await dispatchTab(page, { keyCode: 229 });
  expect(await focused(page)).toBe("a");
  expect(await last(page)).toEqual({ handled: false, prevented: false });
  // Modifier chords are not Tab walks either.
  for (const chord of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    await dispatchTab(page, chord);
    expect(await focused(page)).toBe("a");
  }
  await dispatchTab(page, {});
  expect(await focused(page)).toBe("c");
});
