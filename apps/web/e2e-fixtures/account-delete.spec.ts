/**
 * Settings → Account → "Delete account…" (App Store 5.1.1(v); docs/account-deletion.md) over the
 * real AccountSettings + DeleteAccountDialog and a fake account (fixture `account-delete.html`).
 * Every test forbids the browser's own dialogs (the apps' web views show none).
 * Pinned: the section is last and names the server; the dialog says what happens; Delete stays
 * off until the typed email matches and the password is filled; Enter submits, Escape and Cancel
 * close and return the focus; a refusal is said inside the dialog and nothing is deleted; the
 * server owner gets an explanation instead of a button; a shell without the route shows nothing.
 * Desktop and a 390 px phone.
 */
import { test, expect, type Page } from "@playwright/test";
import { forbidBrowserDialogs } from "./in-app-dialog-helpers";

const PATH = "/e2e-fixtures/account-delete.html";
const EMAIL = "avery@example.test";
const state = (page: Page) => page.evaluate(() => (window as unknown as { prismAccountDelete: { calls: Array<{ confirm: string; password?: string }>; deleted: boolean } }).prismAccountDelete);

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test.describe(`${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("keyboard: open, type email + password, Enter deletes", async ({ page }) => {
      const dialogs = await forbidBrowserDialogs(page);
      await page.goto(PATH);
      const section = page.getByTestId("account-delete");
      await expect(section).toContainText("prism.example.test");
      const open = section.getByRole("button", { name: "Delete account…" });
      await open.focus();
      await page.keyboard.press("Enter");
      const d = page.getByRole("dialog", { name: "Delete your account?" });
      await expect(d).toBeVisible();
      await expect(d).toContainText("prism.example.test");
      await expect(d).toContainText("Your private pages go to the server owner's Trash");
      const email = d.getByLabel("Type your email address to confirm");
      await expect(email).toBeFocused();
      const submit = d.getByRole("button", { name: "Delete account", exact: true });
      await expect(submit).toBeDisabled();
      await page.keyboard.type("AVERY@example.test");
      await expect(submit).toBeDisabled(); // no password yet
      await page.keyboard.press("Tab");
      await expect(d.getByLabel("Password")).toBeFocused();
      await page.keyboard.type("right password");
      await expect(submit).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await state(page)).deleted).toBe(true);
      expect((await state(page)).calls).toEqual([{ confirm: "AVERY@example.test", password: "right password" }]);
      // The dialog fits the screen.
      const box = await d.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(vp.width);
      expect(await dialogs()).toEqual([]);
    });

    test("a wrong password is said in the dialog and nothing is deleted; Escape returns the focus", async ({ page }) => {
      const dialogs = await forbidBrowserDialogs(page);
      await page.goto(PATH);
      const open = page.getByRole("button", { name: "Delete account…" });
      await open.click();
      const d = page.getByRole("dialog", { name: "Delete your account?" });
      await d.getByLabel("Type your email address to confirm").fill(EMAIL);
      await d.getByLabel("Password").fill("wrong one");
      await d.getByRole("button", { name: "Delete account", exact: true }).click();
      await expect(d.getByRole("alert")).toHaveText("That password is incorrect.");
      await expect(d.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
      expect((await state(page)).deleted).toBe(false);
      await page.keyboard.press("Escape");
      await expect(d).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await expect(open).toBeFocused();
      expect(await dialogs()).toEqual([]);
    });

    test("Cancel closes without asking the server", async ({ page }) => {
      await forbidBrowserDialogs(page);
      await page.goto(PATH);
      await page.getByRole("button", { name: "Delete account…" }).click();
      const d = page.getByRole("dialog", { name: "Delete your account?" });
      await d.getByLabel("Type your email address to confirm").fill(EMAIL);
      await d.getByRole("button", { name: "Cancel" }).click();
      await expect(d).toHaveCount(0);
      expect((await state(page)).calls).toEqual([]);
    });

    test("an account without a password: no password field", async ({ page }) => {
      await forbidBrowserDialogs(page);
      await page.goto(`${PATH}?nopassword`);
      await page.getByRole("button", { name: "Delete account…" }).click();
      const d = page.getByRole("dialog", { name: "Delete your account?" });
      await expect(d.getByLabel("Password")).toHaveCount(0);
      await d.getByLabel("Type your email address to confirm").fill(EMAIL);
      await d.getByRole("button", { name: "Delete account", exact: true }).click();
      await expect.poll(async () => (await state(page)).calls).toEqual([{ confirm: EMAIL }]);
    });

    test("the server owner gets an explanation, not a button", async ({ page }) => {
      await forbidBrowserDialogs(page);
      await page.goto(`${PATH}?owner`);
      const section = page.getByTestId("account-delete");
      await expect(section).toContainText("server owner's account");
      await expect(section).toContainText("remove the server");
      await expect(page.getByRole("button", { name: "Delete account…" })).toHaveCount(0);
    });

    test("a shell without the route shows no delete section", async ({ page }) => {
      await page.goto(`${PATH}?nodelete`);
      await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
      await expect(page.getByTestId("account-delete")).toHaveCount(0);
    });
  });
}
