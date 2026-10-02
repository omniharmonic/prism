import { expect, test } from "@playwright/test";
test("name-only workspace creation preserves existing payload and explicit vault move", async ({
  page,
}, info) => {
  await page.goto("/e2e-fixtures/workspace-setup.html");
  await page.getByLabel("New workspace", { exact: true }).fill("Studio");
  await expect(
    page.getByLabel("Workspace address", { exact: true }).first(),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  const workspace = page.getByRole("region", {
    name: "Studio workspace",
    exact: true,
  });
  await expect(workspace).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismSetup.writes)).toEqual([
    { op: "create", name: "Studio", hostname: null },
  ]);
  await workspace
    .getByLabel("Move an existing vault here")
    .selectOption("research");
  expect(
    await page.evaluate(() => (window as any).prismSetup.writes.length),
  ).toBe(1);
  await expect(workspace).toContainText("from Personal workspace to Studio");
  await workspace
    .getByRole("button", { name: "Move vault", exact: true })
    .click();
  await expect(workspace).toContainText("1 vault");
  expect(
    await page.evaluate(() => (window as any).prismSetup.writes[1]),
  ).toEqual({ op: "move", id: "workspace-2", vaultId: "research" });
  await page
    .getByRole("heading", { name: "Your workspaces", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("workspace-setup-desktop.png"),
    fullPage: true,
  });
});
test("failed create keeps fields and double activation is blocked while pending", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-setup.html");
  await page
    .getByLabel("New workspace", { exact: true })
    .fill("Keep this name");
  await page.evaluate(() => {
    (window as any).prismSetup.fail = true;
  });
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("could not save");
  await expect(page.getByLabel("New workspace", { exact: true })).toHaveValue(
    "Keep this name",
  );
  await page.evaluate(() => {
    const c = (window as any).prismSetup;
    c.fail = false;
    c.hold = true;
  });
  await page.getByLabel("New workspace", { exact: true }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Create workspace", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => (window as any).prismSetup.writes.length),
  ).toBe(2);
  await page.evaluate(() => (window as any).prismSetup.release());
  await expect(
    page.getByRole("region", { name: "Keep this name workspace", exact: true }),
  ).toBeVisible();
});
test("custom address updates and deletion remain deliberate and do not change default workspace", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-setup.html");
  const workspace = page.getByRole("region", {
    name: "Field research collective and collaborative planning workspace",
    exact: true,
  });
  await workspace.getByText("Custom address", { exact: true }).click();
  await workspace
    .getByLabel("Workspace address", { exact: true })
    .fill("team.example.test");
  await workspace.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByRole("status")).toContainText("Address saved");
  await workspace
    .getByRole("button", { name: "Delete workspace…", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).prismSetup.writes.length),
  ).toBe(1);
  await workspace
    .getByRole("button", { name: "Keep workspace", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Delete workspace…", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Personal workspace workspace",
      exact: true,
    }),
  ).toBeVisible();
});
test("loading failure retries and actor change hides late success", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-setup.html?load-error");
  await expect(page.getByRole("alert")).toContainText("Workspaces unavailable");
  await page.evaluate(() => {
    (window as any).prismSetup.failList = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("region", {
      name: "Personal workspace workspace",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("New workspace", { exact: true })
    .fill("Old audience draft");
  await page.evaluate(() => {
    (window as any).prismSetup.hold = true;
  });
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.evaluate(() => (window as any).prismSetup.switchScope());
  await expect(
    page.getByRole("region", {
      name: "Another audience workspace",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).prismSetup.release());
  await expect(page.getByText(/Old audience draft created/)).toHaveCount(0);
  await expect(page.getByLabel("New workspace", { exact: true })).toHaveValue(
    "",
  );
});
test("guest authority does not call owner workspace methods and absent seam is honest", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-setup.html?guest");
  await expect(
    page.getByRole("heading", { name: "Workspace settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("New workspace", { exact: true })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => (window as any).prismSetup.reads)).toBe(0);
  await page.goto("/e2e-fixtures/workspace-setup.html?no-provider");
  await expect(page.getByRole("status")).toContainText("server owner");
});
test("phone layout keeps long names and form actions visible in dark mode", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace-setup.html?dark");
  await expect(page.getByLabel("New workspace", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  const button = await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .boundingBox();
  expect(button!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: info.outputPath("workspace-setup-phone-dark.png"),
  });
});
