// "Pair a phone" on the checklist's devices step (QR pairing, D-G). The phone is played by the
// fixture (`window.pairingFixture.claim`); the server's rules are apps/server/test/pairing.test.ts.
import { test, expect, type Page } from "@playwright/test";
import { forbidBrowserDialogs } from "./in-app-dialog-helpers";

const open = async (page: Page, query = "?pairing&reachable") => {
  await forbidBrowserDialogs(page);
  await page.goto(`/e2e-fixtures/setup-checklist.html${query}`);
  await expect(page.getByRole("region", { name: "Setup" })).toBeVisible();
};
const row = (page: Page) => page.locator('[data-step="device"]');
const dialog = (page: Page) => page.getByRole("dialog", { name: "Pair a phone" });
const fx = <T,>(page: Page, f: string) => page.evaluate((expr) => new Function(`return (${expr})`)() as T, f);
const claimAs = (page: Page, label = "Sam's iPhone", code = "4719") => page.evaluate(([l, c]) => (window as any).pairingFixture.claim(l, c), [label, code]);

async function openDialog(page: Page) {
  await row(page).getByRole("button", { name: "Pair a phone" }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole("img", { name: "Pairing code for https://prism.tail1234.ts.net" })).toBeVisible();
  return d;
}

for (const width of [1280, 390])
  test(`pairing at ${width}px: QR → the phone claims → the owner types its code → signed in`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const d = await openDialog(page);
    await expect(d).toContainText("Works once, for 5 minutes");
    await expect(d.getByRole("status")).toHaveText(/Pairing code ready/);
    // The code fits the dialog and the page never scrolls sideways.
    const qr = await d.getByRole("img").boundingBox();
    const box = await d.boundingBox();
    expect(qr!.width).toBeGreaterThan(150);
    expect(qr!.x + qr!.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await claimAs(page);
    // The label is the phone's claim and is presented as one.
    await expect(d).toContainText("A device calling itself “Sam's iPhone” wants to sign in to Prism as you.");
    await expect(d.getByRole("status")).toHaveText(/waiting for your approval/);
    const field = d.getByLabel("Code shown on the phone");
    await expect(field).toBeFocused();
    const approve = d.getByRole("button", { name: "Approve" });
    await expect(approve).toBeDisabled();
    await field.fill("12ab");
    await expect(field).toHaveValue("12");
    await field.fill("1234");
    await approve.click();
    await expect(d.getByText("That code doesn't match the phone.")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("4719");
    await field.press("Enter");
    await expect(d).toContainText("“Sam's iPhone” is signed in.");
    expect(await fx<Array<{ checkCode: string }>>(page, "window.pairingFixture.approved")).toEqual([{ id: "pair_1", checkCode: "1234" }, { id: "pair_1", checkCode: "4719" }]);
    await d.getByRole("button", { name: "Done" }).click();
    await expect(d).toHaveCount(0);
    // The checklist reads the server again: the device step is ticked.
    await expect(row(page)).toHaveAttribute("data-done", "true");
    await expect(row(page).getByRole("button", { name: "Pair another phone" })).toBeVisible();
    // A finished pairing is not "cancelled" on close.
    expect(await fx<string[]>(page, "window.pairingFixture.denied")).toEqual([]);
  });

test("closing the dialog (Escape) cancels the code, and focus returns to the button", async ({ page }) => {
  await open(page);
  await openDialog(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => fx<string[]>(page, "window.pairingFixture.denied")).toEqual(["pair_1"]);
  await expect(row(page).getByRole("button", { name: "Pair a phone" })).toBeFocused();
});

test("declining a claimed phone, and a code someone else also used, both end with Start again", async ({ page }) => {
  await open(page);
  const d = await openDialog(page);
  await claimAs(page, "Unknown phone");
  await d.getByRole("button", { name: "Decline" }).click();
  await expect(d).toContainText("You declined this phone. Nothing was signed in.");
  await d.getByRole("button", { name: "Start again" }).click();
  await expect(d.getByRole("img", { name: /Pairing code for/ })).toBeVisible();
  await page.evaluate(() => (window as any).pairingFixture.end("contested"));
  await expect(d).toContainText("Someone else used this code as well");
  await d.getByRole("button", { name: "Start again" }).click();
  await expect(d.getByRole("img", { name: /Pairing code for/ })).toBeVisible();
  expect(await fx<number>(page, "window.pairingFixture.starts")).toBe(3);
  await page.evaluate(() => (window as any).pairingFixture.end("expired"));
  await expect(d).toContainText("This code expired before the phone was approved.");
});

test("one door: with a device already signed in, a browser can only decline", async ({ page }) => {
  await open(page, "?pairing&reachable&devicefirst");
  const d = await openDialog(page);
  await claimAs(page);
  await expect(d.locator("[data-needs-device]")).toContainText("this phone must be approved from it");
  await expect(d.getByLabel("Code shown on the phone")).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Decline" })).toBeVisible();
});

test("an unreachable server: the button says why, and the server's refusal is explained", async ({ page }) => {
  await open(page, "?pairing");
  const button = row(page).getByRole("button", { name: "Pair a phone" });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(/needs the step above first/);
  // A server that refuses anyway (the address changed under it).
  await page.evaluate(() => { (window as any).pairingFixture.failStart = "not_reachable"; (window as any).setupFixture.done("reachable"); });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(dialog(page)).toContainText("a phone can't reach it yet");
});

test("without a pairing client (an older server, a member), there is no button", async ({ page }) => {
  await open(page, "?reachable");
  await expect(row(page).getByRole("button", { name: /Pair/ })).toHaveCount(0);
});
