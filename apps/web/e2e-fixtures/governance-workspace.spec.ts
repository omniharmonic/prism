import { test, expect } from "@playwright/test";

test("governance sections preserve drafts and exact review actions", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/governance-workspace.html");
  await expect(page.getByTestId("gov-your-access")).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("gov-proposal-card")).toContainText(
    "This handbook collects our working principles.",
  );
  await expect(page.getByTestId("gov-proposal-card")).toContainText(
    "This handbook brings shared ideas into practice.",
  );
  await expect(page.getByTestId("gov-apply")).toBeDisabled();
  await expect(page.getByTestId("gov-amend-composer")).toBeHidden();
  await page
    .getByText("Propose a rule or role change", { exact: true })
    .click();
  await page.getByTestId("gov-amend-role-name").fill("Working reviewers");
  await page
    .getByText("Propose a rule or role change", { exact: true })
    .click();
  await page.getByTestId("gov-vote-reason").fill("Clear and useful.");
  await page.getByRole("tab", { name: "Roles & rules", exact: true }).click();
  await expect(page.getByTestId("gov-role-card")).toContainText("Steward");
  await page.getByTestId("gov-role-edit").click();
  const draft = page.getByTestId("gov-role-card").locator("input").first();
  await draft.fill("Working stewards");
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("gov-vote-reason")).toHaveValue(
    "Clear and useful.",
  );
  await page
    .getByText("Propose a rule or role change", { exact: true })
    .click();
  await expect(page.getByTestId("gov-amend-role-name")).toHaveValue(
    "Working reviewers",
  );
  await page
    .getByText("Propose a rule or role change", { exact: true })
    .click();
  await page.getByRole("tab", { name: "Roles & rules", exact: true }).click();
  await expect(draft).toHaveValue("Working stewards");
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await page.getByTestId("gov-approve").click();
  await expect(page.getByTestId("gov-proposal-progress")).toContainText(
    "1 of 1 approvals",
  );
  await expect(page.getByTestId("gov-apply")).toBeEnabled();
  const votes = await page.evaluate(() =>
    (window as any).governanceFixture.calls.filter((call: any) =>
      call.path.endsWith("/vote"),
    ),
  );
  expect(votes).toEqual([
    {
      path: "/api/governance/proposals/proposal-intro/vote",
      method: "POST",
      body: { vote: "approve", reason: "Clear and useful." },
    },
  ]);
  await page.getByTestId("gov-apply").click();
  await expect(page.getByTestId("gov-proposal-card")).toHaveCount(0);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.getByTestId("gov-audit")).toContainText(
    "alex@example.test",
  );
  await expect(page.getByTestId("gov-history")).toBeVisible();
});

test("section keyboard navigation and failed proposal preserve the authored draft", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/governance-workspace.html");
  const overview = page.getByRole("tab", { name: "Overview", exact: true });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Roles & rules", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "History", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(overview).toBeFocused();
  await page
    .getByRole("button", { name: "Review proposals", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /Proposals/ })).toBeFocused();
  await page.evaluate(() => {
    (window as any).governanceFixture.failWrite = true;
  });
  await page.getByTestId("gov-vote-reason").fill("Keep my reasoning.");
  await page.getByTestId("gov-approve").click();
  await expect(page.getByTestId("gov-error")).toBeVisible();
  await expect(page.getByTestId("gov-vote-reason")).toHaveValue(
    "Keep my reasoning.",
  );
});

for (const width of [1440, 390, 320])
  test(`governance review remains readable at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(
      "/e2e-fixtures/governance-workspace.html" +
        (width === 320 ? "?dark" : ""),
    );
    await page.getByRole("tab", { name: /Proposals/ }).click();
    await expect(page.getByTestId("gov-proposal-card")).toContainText(
      "This handbook brings shared ideas into practice.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByTestId("gov-status-lock")).toContainText("Locked");
    for (const control of [
      page.getByTestId("gov-approve"),
      page.getByTestId("gov-reject"),
      page.getByTestId("gov-vote-reason"),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: info.outputPath(`governance-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    for (const section of ["Overview", "Roles & rules", "History"]) {
      await page.getByRole("tab", { name: section, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `governance-${width}-${section.split(" ")[0]}.png`,
        ),
        fullPage: true,
        animations: "disabled",
      });
    }
  });
