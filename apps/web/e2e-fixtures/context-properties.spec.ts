import { test, expect } from "@playwright/test";

for (const mode of ["readonly", "propose"])
  test(`${mode} can inspect properties and tags without edit controls`, async ({ page }) => {
    await page.goto("/e2e-fixtures/context-properties.html?" + mode);
    await expect(page.getByRole("region", { name: "Page properties" })).toContainText("Alex Chen");
    await expect(page.getByRole("button", { name: "project", exact: true })).toBeVisible();
    await expect(page.getByLabel("Add tag", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Page type")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).contextProperties.writes.length)).toBe(0);
  });

for (const mode of ["owner", "edit"])
  test(`${mode} commits text once, retains failed input and retries`, async ({ page }) => {
    await page.goto("/e2e-fixtures/context-properties.html?" + mode);
    const owner = page.getByRole("textbox", { name: "Owner", exact: true });
    await owner.fill("Morgan Lee");
    expect(await page.evaluate(() => (window as any).contextProperties.writes.length)).toBe(0);
    await page.evaluate(() => {
      (window as any).contextProperties.fail = true;
    });
    await owner.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Not saved." })).toBeVisible();
    await expect(owner).toHaveValue("Morgan Lee");
    await page.evaluate(() => {
      (window as any).contextProperties.fail = false;
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).contextProperties.writes)).toEqual([
      {
        kind: "property",
        value: {
          metadata: {
            type: "document",
            owner: "Morgan Lee",
            priority: "Normal",
            approved: false,
            topics: ["Research"],
          },
        },
        scope: "fixture-a",
      },
      {
        kind: "property",
        value: {
          metadata: {
            type: "document",
            owner: "Morgan Lee",
            priority: "Normal",
            approved: false,
            topics: ["Research"],
          },
        },
        scope: "fixture-a",
      },
    ]);
  });

test("tags use injected client, retain failure input, and never double submit while saving", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/context-properties.html");
  const input = page.getByRole("textbox", { name: "Add tag", exact: true });
  await input.fill("research");
  await page.evaluate(() => {
    (window as any).contextProperties.fail = true;
  });
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("tag could not be saved");
  await expect(input).toHaveValue("research");
  await page.evaluate(() => {
    const c = (window as any).contextProperties;
    c.fail = false;
    c.hold = true;
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.evaluate(() => {
    const c = (window as any).contextProperties;
    c.hold = false;
    c.pending.splice(0).forEach((r: () => void) => r());
  });
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove tag research" })).toBeVisible();
  await page.getByRole("button", { name: "Remove tag research" }).click();
  await expect(page.getByRole("button", { name: "Remove tag research" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).contextProperties.writes.map((w: any) => w.kind))).toEqual(
    ["add", "add", "remove"],
  );
});

test("array property retains failed input; scope change resets unsaved drafts", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-properties.html");
  const input = page.getByRole("textbox", { name: "Add Topics" });
  await input.fill("Discovery");
  await page.evaluate(() => {
    (window as any).contextProperties.fail = true;
  });
  await input.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Not saved." })).toBeVisible();
  await expect(input).toHaveValue("Discovery");
  await page.getByRole("textbox", { name: "Owner", exact: true }).fill("Unsent draft");
  // Switch without blurring the input: emulate an authenticated scope change.
  await page.evaluate(() => {
    (window as any).contextProperties.scope = "fixture-b";
  });
  await page.getByRole("button", { name: "Switch workspace" }).dispatchEvent("click");
  await expect(page.getByRole("textbox", { name: "Owner", exact: true })).toHaveValue("Alex Chen");
});

for (const appearance of ["desktop", "phone", "dark"])
  test(`properties visual ${appearance}`, async ({ page }, info) => {
    await page.setViewportSize(
      appearance === "phone" ? { width: 390, height: 844 } : { width: 980, height: 1050 },
    );
    await page.goto("/e2e-fixtures/context-properties.html?" + appearance);
    await expect(page.getByRole("textbox", { name: "Owner", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (appearance === "phone")
      for (const selector of ["select", "[role=switch]", 'input[aria-label="Add tag"]'])
        expect((await page.locator(selector).first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.locator("main").screenshot({ path: info.outputPath(`properties-${appearance}.png`) });
  });
