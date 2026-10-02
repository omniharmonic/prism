import { test, expect } from "@playwright/test";
const openSaved = async (page: import("@playwright/test").Page) => {
  await page.getByText("Saved view", { exact: true }).click();
};
test("saved view restores actual focus and filters after reload without storing graph records", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await page
    .getByRole("button", { name: "Focus People and conversations" })
    .click();
  await page.getByLabel("Connection depth").selectOption("2");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Relationship filter").selectOption("explores");
  await page.getByLabel("Search loaded connections").fill("people");
  await openSaved(page);
  await page.getByRole("button", { name: "Save current view" }).click();
  await expect(
    page.locator(".prism-graph__saved").getByRole("status"),
  ).toContainText("View saved on this device");
  const raw = await page.evaluate(
    () => localStorage.getItem("prism:graph-views:v1")!,
  );
  const entry = JSON.parse(raw)[0];
  expect(entry.view.centers).toEqual(["home", "people"]);
  expect(raw).not.toContain("People and conversations");
  expect(raw).not.toContain("Projects/Prism");
  expect(raw).not.toContain("Synthetic graph document");
  await page.reload();
  await openSaved(page);
  await page.getByRole("button", { name: "Restore saved view" }).click();
  await expect(
    page.getByRole("heading", {
      name: "People and conversations",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Connection depth")).toHaveValue("2");
  await expect(page.getByLabel("Relationship filter")).toHaveValue("explores");
  await expect(page.getByLabel("Search loaded connections")).toHaveValue(
    "people",
  );
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Remove saved view" }).click();
  await page.reload();
  await openSaved(page);
  await expect(
    page.getByRole("button", { name: "Restore saved view" }),
  ).toBeDisabled();
});
test("saved 2D camera survives mode change reload and explicit fullscreen restoration", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  const map = page.getByRole("group", { name: "Document connection map" });
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await map.focus();
  await page.keyboard.press("ArrowRight");
  const camera = await map.getAttribute("viewBox");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(map).toHaveAttribute("viewBox", camera!);
  await openSaved(page);
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.reload();
  await openSaved(page);
  await page.getByRole("button", { name: "Restore saved view" }).click();
  await expect(map).toHaveAttribute("viewBox", camera!);
  await page.getByRole("button", { name: "Expand graph" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Explore connected knowledge",
  });
  await dialog.getByText("Saved view", { exact: true }).click();
  await dialog.getByRole("button", { name: "Restore saved view" }).click();
  await expect(
    dialog.locator(".prism-graph__saved").getByRole("status"),
  ).toContainText("Saved settings restored");
  await expect(
    dialog.getByRole("group", { name: "Document connection map" }),
  ).toBeVisible();
});
test("saved settings are segregated by document and audience and unknown identity cannot save", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await openSaved(page);
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.evaluate(() =>
    (window as any).prismGraphStore.setState({ scope: "graph-b" }),
  );
  await openSaved(page);
  await expect(
    page.getByRole("button", { name: "Restore saved view" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as any).prismGraphStore.setState({ scope: "graph-a" }),
  );
  await openSaved(page);
  await expect(
    page.getByRole("button", { name: "Restore saved view" }),
  ).toBeEnabled();
  await page.evaluate(() => (window as any).prismGraphFixture.setRoot("ideas"));
  await expect(
    page.getByRole("heading", { name: "Connected ideas", exact: true }),
  ).toBeVisible();
  await openSaved(page);
  await expect(
    page.getByRole("button", { name: "Restore saved view" }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as any).prismGraphStore.setState({ scope: null }),
  );
  await openSaved(page);
  await expect(
    page.getByRole("button", { name: "Save current view" }),
  ).toBeDisabled();
});
test("restoration revalidates access instead of showing cached graph titles", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/graph.html");
  await openSaved(page);
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.evaluate(() => ((window as any).prismGraphFixture.fail = true));
  await page.getByRole("button", { name: "Restore saved view" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Couldn’t load these connections",
  );
  await expect(
    page.getByRole("button", { name: "Focus People and conversations" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "A living workspace", exact: true }),
  ).toHaveCount(0);
});
for (const scenario of ["corrupt", "denied"])
  test(`saved-view ${scenario} storage leaves graph usable`, async ({
    page,
  }) => {
    await page.goto("/e2e-fixtures/graph.html");
    await page.evaluate((mode) => {
      if (mode === "corrupt")
        localStorage.setItem("prism:graph-views:v1", "{broken");
      else
        Storage.prototype.setItem = function () {
          throw new Error("storage denied");
        };
    }, scenario);
    await openSaved(page);
    await page.getByRole("button", { name: "Save current view" }).click();
    await expect(
      page.locator(".prism-graph__saved").getByRole("status"),
    ).toContainText("could not be saved");
    await expect(
      page.getByRole("button", { name: "Focus People and conversations" }),
    ).toBeVisible();
  });

for (const width of [1440, 390, 320])
  test(`saved graph controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(
      "/e2e-fixtures/graph.html" + (width === 320 ? "?dark" : ""),
    );
    await openSaved(page);
    await page.getByRole("button", { name: "Save current view" }).click();
    await expect(
      page.locator(".prism-graph__saved").getByRole("status"),
    ).toContainText("View saved on this device");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const label of [
      "Save current view",
      "Restore saved view",
      "Remove saved view",
    ])
      expect(
        (await page.getByRole("button", { name: label }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: info.outputPath(`graph-saved-${width}.png`),
      animations: "disabled",
    });
  });
