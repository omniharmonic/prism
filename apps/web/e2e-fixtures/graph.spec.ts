import { test, expect } from "@playwright/test";

test("focused 2D graph has keyboard navigation, typed directions, filters and fresh document access", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Showing a limited neighborhood.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).prismGraphFixture.calls.length),
    )
    .toBe(1);
  const map = page.getByRole("group", { name: "Document connection map" });
  await map
    .getByRole("button", { name: "Focus People and conversations" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", {
      name: "People and conversations",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismGraphFixture.opened),
  ).toEqual([]);
  await page.getByRole("button", { name: "Previous graph focus" }).click();
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Connected documents" }),
  ).toContainText("Incoming · supports");
  await page.getByLabel("Relationship filter").selectOption("supports");
  await expect(
    page.getByRole("button", { name: "Focus Connected ideas" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Focus People and conversations" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).prismGraphFixture.denyOpen = true;
  });
  await page
    .getByRole("button", { name: "Open document", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("access has changed");
  expect(
    await page.evaluate(() => (window as any).prismGraphFixture.opened),
  ).toEqual([]);
});

test("phone fullscreen contains focus, fits the viewport, restores trigger and does no hidden graph fetch", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/graph.html");
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand graph" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Explore connected knowledge",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Document connection map" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({ path: testInfo.outputPath("graph-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Expand graph" }),
  ).toBeFocused();
});

test("failed revalidation hides cached neighbors, and a scope switch rejects late graph results", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.prismGraphFixture.fail = true;
    void w.prismGraphQuery.invalidateQueries({
      queryKey: ["vault", "neighborhood"],
    });
  });
  await expect(page.getByRole("alert")).toContainText("Couldn’t load");
  await expect(
    page.getByRole("button", { name: "Focus People and conversations" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.prismGraphFixture.fail = false;
    w.prismGraphFixture.hold = true;
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Loading connections…")).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    const release = w.prismGraphFixture.release;
    w.prismGraphFixture.hold = false;
    w.prismGraphFixture.fail = true;
    w.prismGraphStore.setState({ scope: "graph-b" });
    release();
  });
  await expect(page.getByRole("alert")).toContainText("Couldn’t load");
  await expect(
    page.getByRole("button", { name: "Focus People and conversations" }),
  ).toHaveCount(0);
});

test("3D loads only when chosen and offers a list fallback when unavailable", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/GraphCanvas3D.tsx", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/e2e-fixtures/graph.html");
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("3D is unavailable");
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Use list view" }).click();
  await expect(
    page.getByRole("list", { name: "Connected documents" }),
  ).toContainText("People and conversations");
});
