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

test("3D tooltip consumer treats document and relationship markup as literal text", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toBeVisible();
  const label =
    '<img src=x onerror="window.prismTooltipInjected=true"> <b>Research</b> & planning';
  await page.evaluate(
    (text) => (window as any).prismGraphFixture.showTooltip(text),
    label,
  );
  await expect(page.locator(".float-tooltip-kap")).toHaveText(label);
  await expect(
    page.locator(".float-tooltip-kap img,.float-tooltip-kap b"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).prismTooltipInjected),
  ).toBeUndefined();
});


test("search filters the loaded neighborhood without fetching and keeps the current focus", async ({ page }) => {
  await page.goto("/e2e-fixtures/graph.html");
  await expect(page.getByRole("heading", { name: "A living workspace", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Search loaded connections").fill("research");
  const list = page.getByRole("list", { name: "Connected documents" });
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(list).toContainText("#research");
  await expect(list).toContainText("Outgoing · explores");
  await page.getByLabel("Relationship filter").selectOption("supports");
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(page.getByText("No connections match these filters.", { exact: false })).toBeVisible();
  await expect(page.getByText("No connections yet.", { exact: false })).toHaveCount(0);
  await page.getByLabel("Search loaded connections").fill("");
  await expect(list.getByRole("button")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).prismGraphFixture.calls)).toEqual(["home"]);
  await list.getByRole("button", { name: "Focus Connected ideas" }).click();
  await expect(page.getByLabel("Relationship filter")).toHaveValue("");
  await expect(page.getByLabel("Search loaded connections")).toHaveValue("");
});

for (const width of [1440, 390, 320]) {
  test(`dense graph remains bounded and all loaded notes are available in list at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/e2e-fixtures/graph.html?dense${width === 320 ? "&dark" : ""}`);
    const map = page.getByRole("group", { name: "Document connection map" });
    await expect(map.getByRole("button")).toHaveCount(width > 600 ? 9 : 5);
    await expect(page.getByText(`of 32 documents.`, { exact: false })).toBeVisible();
    await map.focus();
    const originalView = await map.getAttribute("viewBox");
    await page.keyboard.press("ArrowRight");
    await expect(map).not.toHaveAttribute("viewBox", originalView!);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Reset view" }).click();
    await expect(map).toHaveAttribute("viewBox", originalView!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`graph-${width}.png`) });
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("list", { name: "Connected documents" }).getByRole("button")).toHaveCount(32);
    await page.getByLabel("Search loaded connections").fill("Research/Document 28");
    await expect(page.getByRole("list", { name: "Connected documents" }).getByRole("button")).toHaveCount(2);
  });
}
