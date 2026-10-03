import { test, expect, type Page } from "@playwright/test";

/** Request access (NP-CO-13): a member asks for a page they can't open; the owner approves from the Inbox. */
const SHOTS = process.env.INBOX_SHOTS;
const url = (q = "") => `/e2e-fixtures/notion-inbox.html${q}`;
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

test("request access → owner approves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The member opens a page they cannot view: no title, no content — just a way to ask.
  await page.goto(url("?reset&as=member&open=secret"));
  const main = page.locator("#workspace-document");
  await expect(main.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
  await expect(main).not.toContainText("Confidential");
  await expect(main).not.toContainText("Budget 2027");
  await shot(page, "request-access-1440-light");
  await main.getByRole("button", { name: "Request access" }).click();
  await expect(main.getByRole("status")).toHaveText(/Request sent/);
  expect((await writes(page)).find((w) => w.requestAccess)).toEqual({ requestAccess: { noteId: "secret", level: "view" } });

  // The owner sees the request in the Inbox and approves it with a level.
  await page.goto(url("?as=owner&open=notifications"));
  const row = page.getByTestId("notification-row").filter({ hasText: "Sam Ortiz requested access to Budget 2027" });
  await expect(row).toHaveAttribute("data-unread", "true");
  await shot(page, "access-request-owner-1440-light");
  await row.getByLabel("Access level").selectOption("edit");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByTestId("access-decided")).toHaveText("Approved · can edit");
  expect((await writes(page)).find((w) => w.decide)).toMatchObject({ decide: "req-1", decision: "approve", level: "edit" });

  // The member now opens the page and is told the request was approved.
  await page.goto(url("?as=member&open=secret"));
  await expect(page.locator("#workspace-document")).toContainText("Confidential numbers.");
  await page.locator(".workspace-navigation").first().getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByTestId("notification-row").filter({ hasText: "Your access request was approved: Budget 2027" })).toBeVisible();
});
