import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the in-app replacements of `window.prompt / confirm / alert`.
 *
 * The Prism Client's web view (Tauri / wry, macOS and iOS) implements no JavaScript-dialog
 * delegate: a `prompt()` answers null, a `confirm()` answers false and an `alert()` shows
 * nothing. `forbidBrowserDialogs` makes a fixture page behave at least as strictly — any
 * remaining call THROWS and is recorded — so a spec fails if shipped UI reaches for one.
 */
export async function forbidBrowserDialogs(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __browserDialogCalls: string[] }).__browserDialogCalls = calls;
    for (const name of ["prompt", "confirm", "alert"] as const) {
      Object.defineProperty(window, name, {
        configurable: true,
        value: (message?: unknown) => { calls.push(`${name}(${String(message ?? "")})`); throw new Error(`window.${name}() is not available in the app's web view`); },
      });
    }
  });
  // A native dialog that still reaches the browser (a frame the init script missed) fails the test too.
  page.on("dialog", (d) => { void d.dismiss(); throw new Error(`browser ${d.type()} dialog: ${d.message()}`); });
  return () => page.evaluate(() => (window as unknown as { __browserDialogCalls?: string[] }).__browserDialogCalls ?? []);
}

export type AddressField = "Image address" | "Link to embed" | "Link for the bookmark" | "Link address";

/** The editor's in-app address field (`EditorPrompt`), open and holding the focus. */
export async function addressField(page: Page, name: AddressField) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox", { name, exact: true });
  await expect(field).toBeFocused();
  return { dialog, field };
}

/** Type an address into the field and press Enter. */
export async function enterAddress(page: Page, name: AddressField, value: string) {
  const { dialog, field } = await addressField(page, name);
  await field.fill(value);
  await field.press("Enter");
  return dialog;
}

/** Answer the in-app confirmation (`askConfirm` / `ConfirmDialog`). `answer` is the button's name. */
export async function answerConfirm(page: Page, answer: string | RegExp, title?: string | RegExp) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  if (title) await expect(dialog).toContainText(title);
  await dialog.getByRole("button", { name: answer, exact: typeof answer === "string" }).click();
  await expect(dialog).toHaveCount(0);
}
