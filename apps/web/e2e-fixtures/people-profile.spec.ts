import { test, expect } from "@playwright/test";

for (const [width, dark] of [
  [1440, false],
  [390, false],
  [320, true],
] as const) {
  test(`People profile is readable at ${width}px ${dark ? "dark" : "light"}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 940 });
    await page.goto(`/e2e-fixtures/people-profile.html${dark ? "?dark" : ""}`);
    await page
      .getByRole("button", { name: "Morgan Lee Research partner" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Morgan Lee", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("definition").filter({ hasText: "morgan@example.test" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Project discussion/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(
        `people-profile-${width}-${dark ? "dark" : "light"}.png`,
      ),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Gather the research notes/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Project discussion/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Back to People" }).click();
    await page
      .getByRole("button", { name: /A very long canonical person/ })
      .click();
    await expect(page.getByRole("definition")).toContainText(
      "a-very-long-exact-account-identifier-preserved@example.test",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("directory keeps exact selection, query and keyboard return across breakpoints", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/people-profile.html");
  await page.getByLabel("Find people").fill("Alex");
  const designer = page.getByRole("button", {
    name: "Alex Rivera Product designer",
  });
  await expect(page.getByRole("button", { name: /Alex Rivera/ })).toHaveCount(
    2,
  );
  await designer.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("definition")).toContainText(
    "design@example.test",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByLabel("Find people")).toHaveValue("Alex");
  await expect(designer).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Back to People" }).click();
  await expect(designer).toBeFocused();
  await expect(page.getByLabel("Find people")).toHaveValue("Alex");
  await page
    .getByRole("button", { name: "Alex Rivera Engineering partner" })
    .click();
  await expect(page.getByRole("definition")).toContainText(
    "engineering@example.test",
  );
});

test("fresh profile failure hides accounts and records; note opens recheck access", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/people-profile.html?deep");
  await expect(
    page.getByRole("definition").filter({ hasText: "morgan@example.test" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const c = (window as any).prismPeople;
    c.denyNote = true;
  });
  await page.getByRole("button", { name: "Open person note" }).click();
  await expect(page.getByRole("alert")).toContainText("access has changed");
  await expect(page.getByLabel("Opened notes")).not.toContainText("morgan");
  await page.evaluate(() => {
    const c = (window as any).prismPeople;
    c.denyProfile = true;
    void c.refresh();
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByRole("definition")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Project discussion/ }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as any).prismPeople;
    c.denyProfile = false;
    c.denyNote = false;
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "Open person note" }).click();
  await expect(page.getByLabel("Opened notes")).toContainText("morgan");
});

test("late profile response cannot restore another workspace's identity", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/people-profile.html");
  await expect(
    page.getByRole("button", { name: "Morgan Lee Research partner" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismPeople.hold = true;
  });
  await page
    .getByRole("button", { name: "Morgan Lee Research partner" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Loading person" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const c = (window as any).prismPeople;
    c.switchScope();
    c.release();
  });
  await expect(
    page.getByRole("heading", { name: "Your people start here" }),
  ).toBeVisible();
  await expect(page.getByRole("definition")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Morgan Lee", exact: true }),
  ).toHaveCount(0);
});

test("failed identity edit retains scoped draft and revision through layout changes", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/people-profile.html?deep");
  await page.getByText("Manage accounts", { exact: true }).click();
  await page.getByLabel("Account identifier").fill("draft@example.test");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("revision changed");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByLabel("Account identifier")).toHaveValue(
    "draft@example.test",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).prismPeople.writes)).toEqual(
    [
      {
        id: "morgan",
        kind: "email",
        value: "draft@example.test",
        action: "add",
        ifUpdatedAt: "2026-10-01",
      },
    ],
  );
});

test("read-only profile offers source navigation but no identity mutation", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/people-profile.html?deep&readonly");
  await expect(
    page.getByRole("button", { name: "Open person note" }),
  ).toBeVisible();
  await expect(page.getByText("Manage accounts", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Remove account/ }),
  ).toHaveCount(0);
});

test("phone directory scroll is retained after viewing a person", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/people-profile.html?many");
  const target = page.getByRole("button", {
    name: "Fictional person 20 Research participant",
    exact: true,
  });
  await target.scrollIntoViewIfNeeded();
  const list = page.locator(".prism-people-list");
  const before = await list.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await target.click();
  await expect(
    page.getByRole("heading", { name: "Fictional person 20", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to People" }).click();
  await expect(target).toBeFocused();
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
});
