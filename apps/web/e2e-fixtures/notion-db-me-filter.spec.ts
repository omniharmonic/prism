import { test, expect, type Page } from "@playwright/test";

/**
 * "Me" as a person filter value: a saved view stores the token `@me` — never a
 * name or an address — and it is resolved for whoever is looking. Fixture:
 * databases.html (its query stands in for the server: the caller is Mira).
 */
const configWrites = (page: Page) => page.evaluate(() => ((window as any).dbFixture.writes as any[]).filter((w) => w.metadata?.prism_database));
const queries = (page: Page) => page.evaluate(() => (window as any).dbFixture.queries as any[]);
const table = (page: Page) => page.getByRole("table", { name: "All tasks" });
const titles = (page: Page) => table(page).locator("tbody tr[data-row-id] .db-row-open").allTextContents();

test("a person filter can be `Me`: the view saves the token and shows the caller's rows", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(table(page).getByRole("button", { name: "Review workspace navigation", exact: true })).toBeVisible();
  const all = (await titles(page)).length;
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await dialog.getByLabel("Condition 1 property").selectOption("assignee");
  // A person property offers "Me" beside the name field.
  const me = dialog.getByRole("button", { name: "Filter by me" });
  await expect(me).toHaveAttribute("aria-pressed", "false");
  await me.click();
  await expect(me).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Filter value")).toHaveCount(0);
  await expect.poll(() => titles(page)).toEqual(["Review workspace navigation"]);
  const saved = (await configWrites(page)).at(-1).metadata.prism_database.views[0].filter;
  expect(saved.conditions).toEqual([{ key: "assignee", op: "contains", value: "@me" }]);
  expect(JSON.stringify(saved)).not.toMatch(/Mira|example\.test/);
  expect((await queries(page)).at(-1).filter.conditions[0].value).toBe("@me");

  // "does not contain Me" is everyone else's rows.
  await dialog.getByLabel("Condition 1 operator").selectOption("not_contains");
  await expect.poll(async () => (await titles(page)).length).toBe(all - 1);
  expect(await titles(page)).not.toContain("Review workspace navigation");

  // Created by / Last edited by take it too; a text property does not.
  await dialog.getByLabel("Condition 1 property").selectOption("prism_creator");
  await dialog.getByLabel("Condition 1 operator").selectOption("eq");
  await dialog.getByRole("button", { name: "Filter by me" }).click();
  await expect.poll(() => titles(page)).toEqual(["Review workspace navigation"]);
  await dialog.getByLabel("Condition 1 property").selectOption("prism_last_writer");
  await dialog.getByLabel("Condition 1 operator").selectOption("eq");
  await dialog.getByRole("button", { name: "Filter by me" }).click();
  await expect.poll(() => titles(page)).toEqual(["Write release notes"]);
  await dialog.getByLabel("Condition 1 property").selectOption("link");
  await expect(dialog.getByRole("button", { name: "Filter by me" })).toHaveCount(0);

  // Pressing "Me" again goes back to a name.
  await dialog.getByLabel("Condition 1 property").selectOption("assignee");
  await dialog.getByRole("button", { name: "Filter by me" }).click();
  await dialog.getByRole("button", { name: "Filter by me" }).click();
  await dialog.getByLabel("Filter value").fill("Sam");
  await expect.poll(() => titles(page)).toEqual(["Write release notes"]);
});

test("a saved `Me` view survives a reload and still holds only the token", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await dialog.getByLabel("Condition 1 property").selectOption("assignee");
  await dialog.getByRole("button", { name: "Filter by me" }).click();
  await expect.poll(() => titles(page)).toEqual(["Review workspace navigation"]);
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(["Review workspace navigation"]);
  await page.getByRole("button", { name: /^Filter/ }).click();
  await expect(page.getByRole("dialog", { name: "Filter" }).getByRole("button", { name: "Filter by me" })).toHaveAttribute("aria-pressed", "true");
});
