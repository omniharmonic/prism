import { test, expect } from "@playwright/test";

/**
 * L-1 (2026-11-08): the Mac client went flat grey during an agent burst and left no record.
 * An error that escapes every boundary must now leave a Reload screen and a report; the app's
 * boundary offers Reload and reports; unhandled rejections and main-thread stalls are recorded
 * (the stall watch is a heartbeat — WebKit, i.e. the Mac and iOS apps, has no Long Tasks API).
 */
const posted = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).prismClientErrors.posted as Array<{ kind: string; message: string; route?: string; build?: string; detail?: string }>);

test("an error outside every boundary: plain-DOM Reload screen, not a grey window, and a report", async ({ page }) => {
  await page.goto("/e2e-fixtures/client-errors.html?t=CAPABILITY-SECRET");
  await expect(page.getByTestId("app")).toHaveText("Working app");
  await page.evaluate(() => (window as any).prismClientErrors.crashOutside());
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading", { name: "Prism stopped working" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "Reload Prism" })).toBeFocused();
  await expect(page.getByTestId("app")).toHaveCount(0); // React really unmounted the root
  const reports = await posted(page);
  const uncaught = reports.find((r) => r.kind === "uncaught");
  expect(uncaught?.message).toContain("effect blew up outside any boundary");
  expect(uncaught?.route).toBe("/e2e-fixtures/client-errors.html"); // never the ?t= token
  expect(uncaught?.build).toBe("test-build");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("prism:client-errors") ?? "[]"));
  expect(kept[0].kind).toBe("uncaught");
  await alert.getByRole("button", { name: "Reload Prism" }).click();
  await expect(page.getByTestId("app")).toHaveText("Working app");
});

test("the app's error boundary offers Reload and reports what it caught", async ({ page }) => {
  await page.goto("/e2e-fixtures/client-errors.html?boundary");
  const alert = page.getByRole("alert");
  await expect(alert.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "Reload Prism" })).toBeVisible();
  await expect.poll(async () => (await posted(page)).some((r) => r.kind === "boundary" && r.message.includes("render blew up inside the app boundary"))).toBe(true);
});

test("unhandled rejections and main-thread stalls are recorded; noise and repeats are not", async ({ page }) => {
  await page.goto("/e2e-fixtures/client-errors.html");
  await expect(page.getByTestId("app")).toBeVisible();
  await page.evaluate(() => (window as any).prismClientErrors.reject());
  await expect.poll(async () => (await posted(page)).filter((r) => r.kind === "rejection").length).toBe(1);
  // A 2.5 s busy main thread is a stall (reported once, with its length).
  await page.waitForTimeout(1_200);
  await page.evaluate(() => (window as any).prismClientErrors.block(2_600));
  await expect.poll(async () => (await posted(page)).find((r) => r.kind === "stall")?.detail ?? "", { timeout: 5_000 }).toMatch(/^stalled \d+ ms$/);
  // Noise is dropped; the same error twice within a minute is one report.
  await page.evaluate(() => {
    const e = (window as any).prismClientErrors;
    e.report("error", "ResizeObserver loop completed with undelivered notifications.");
    e.report("error", "Same thing twice");
    e.report("error", "Same thing twice");
  });
  const r = await posted(page);
  expect(r.filter((x) => x.message.startsWith("ResizeObserver"))).toHaveLength(0);
  expect(r.filter((x) => x.message === "Same thing twice")).toHaveLength(1);
});
