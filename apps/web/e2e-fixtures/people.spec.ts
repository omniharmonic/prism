import { test, expect } from "@playwright/test";
test("people separates equal names and navigates exact canonical relationships", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace.html?people");
  const people = page.getByRole("region", { name: "People workspace" });
  await expect(
    people.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(people.getByRole("button", { name: /Alex Morgan/ })).toHaveCount(
    2,
  );
  await people.getByRole("button", { name: "Alex Morgan Designer" }).click();
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.design@example.test" }),
  ).toBeVisible();
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.engineering@example.test" }),
  ).toHaveCount(0);
  await people
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await expect(
    people.getByRole("button", { name: /Project conversation/ }),
  ).toBeVisible();
  await expect(
    people.getByRole("button", { name: /Weekly planning/ }),
  ).toHaveCount(0);
  await people.getByRole("button", { name: /Project conversation/ }).click();
  await expect(
    page.getByRole("heading", { name: "Field notes", exact: true }).first(),
  ).toBeVisible();
});
test("people search and phone layout preserve separate identities without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace.html?people");
  await page.getByLabel("Find people").fill("engineering@example.test");
  const people = page.getByRole("region", { name: "People workspace" });
  await expect(people.getByRole("button", { name: /Alex Morgan/ })).toHaveCount(
    1,
  );
  await people.getByRole("button", { name: "Alex Morgan Engineer" }).click();
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.engineering@example.test" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/people-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.engineering@example.test" }),
  ).toBeVisible();
});
test("failed person load can recover and a denied linked note never opens", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace.html?people");
  const people = page.getByRole("region", { name: "People workspace" });
  await expect(people.getByRole("button", { name: /Alex Morgan/ })).toHaveCount(
    2,
  );
  await page.evaluate(() => {
    (window as any).prismFixtureControls.peopleFail = true;
  });
  await people.getByRole("button", { name: "Alex Morgan Designer" }).click();
  await expect(people.getByRole("alert")).toContainText("unavailable");
  await page.evaluate(() => {
    (window as any).prismFixtureControls.peopleFail = false;
  });
  await people.getByRole("button", { name: "Try again" }).click();
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.design@example.test" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismFixtureControls.peopleDenyOpen = true;
  });
  await people.getByRole("button", { name: /Project conversation/ }).click();
  await expect(people.getByRole("alert")).toContainText("access has changed");
  await expect(
    people.getByRole("heading", { name: "Alex Morgan", exact: true }),
  ).toBeVisible();
});

test("reviewed identity changes retain failed drafts across layouts and preserve revision guards", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace.html?people");
  const people = page.getByRole("region", { name: "People workspace" });
  await people.getByRole("button", { name: "Alex Morgan Designer" }).click();
  await people.getByText("Manage accounts", { exact: true }).click();
  await people.getByLabel("Account identifier").fill("new@example.test");
  await page.evaluate(() => {
    (window as any).prismFixtureControls.rejectWrite = true;
  });
  await people
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(people.getByRole("alert")).toContainText("changed");
  await expect(people.getByLabel("Account identifier")).toHaveValue(
    "new@example.test",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  // The same document area now stays mounted: its disclosure stays open too.
  await expect(people.getByLabel("Account identifier")).toBeVisible();
  await expect(people.getByLabel("Account identifier")).toHaveValue(
    "new@example.test",
  );
  await page.evaluate(() => {
    (window as any).prismFixtureControls.rejectWrite = false;
  });
  await people
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(
    people.locator("dd").filter({ hasText: "new@example.test" }),
  ).toBeVisible();
  const writes = await page.evaluate(() => (window as any).prismFixtureWrites);
  expect(writes.at(-1)).toEqual({
    kind: "email",
    value: "new@example.test",
    action: "add",
    ifUpdatedAt: "2026-10-01T12:00:00.000Z",
  });
  // Fast refreshes may stay in one render, preserving the disclosure.
  if (!(await people.getByLabel("Account identifier").isVisible())) {
    await people.getByText("Manage accounts", { exact: true }).click();
  }
  await expect(people.getByLabel("Account identifier")).toHaveValue("");
  await people
    .getByRole("button", {
      name: "Remove account new@example.test",
      exact: true,
    })
    .click();
  await expect(
    people.locator("dd").filter({ hasText: "new@example.test" }),
  ).toHaveCount(0);
});
test("read-only person access never offers identity mutations", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace.html?people-readonly");
  const people = page.getByRole("region", { name: "People workspace" });
  await people.getByRole("button", { name: "Alex Morgan Designer" }).click();
  await expect(
    people.getByRole("definition").filter({ hasText: "alex.design@example.test" }),
  ).toBeVisible();
  await expect(
    people.getByText("Manage accounts", { exact: true }),
  ).toHaveCount(0);
});
