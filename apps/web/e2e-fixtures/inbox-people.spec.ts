import { test, expect, type Page } from "@playwright/test";
async function people(page: Page) {
  await page.goto("/e2e-fixtures/inbox.html?identity");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Canonical recipient/ }),
  ).toBeVisible();
}
test("People hides exact tombstone/nonhuman markers without removing raw notes", async ({
  page,
}) => {
  await people(page);
  await expect(page.getByRole("button", { name: /Hidden / })).toHaveCount(0);
  for (const label of [
    "Morgan",
    "Live snake pointer",
    "Live camel pointer",
    "Live successor pointer",
    "Document human",
    "Canonical recipient",
    "Reverse recipient",
  ])
    await expect(
      page.getByRole("button", { name: new RegExp(label) }),
    ).toBeVisible();
  expect(
    await page.evaluate(() => {
      const q = (window as any).prismInboxQuery
        .getQueryCache()
        .getAll()
        .find((q: any) =>
          q.queryKey.some((part: any) => part?.tag === "person"),
        );
      return q.state.data.length;
    }),
  ).toBe(15);
  await expect(page.getByText(/5 conversations/)).toBeVisible();
});
test("recipient email links work in either direction and multiple relations do not duplicate a thread", async ({
  page,
}, info) => {
  await people(page);
  const canonical = page.getByRole("button", { name: /Canonical recipient/ });
  await expect(canonical).toContainText("1 thread");
  await canonical.click();
  await expect(
    page.getByRole("button", { name: /Recipient record/ }),
  ).toHaveCount(1);
  await canonical.click();
  await page.getByRole("button", { name: /Reverse recipient/ }).click();
  await expect(
    page.getByRole("button", { name: /Recipient record/ }),
  ).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("canonical-message-people.png"),
  });
  await page.getByRole("button", { name: /Recipient record/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Selected conversation" })
      .getByText("A real linked email body.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismInboxFixture.sends),
  ).toEqual([]);
});
test("canonical People state suppresses stale data after failed revalidation and workspace switch", async ({
  page,
}) => {
  await people(page);
  await page.evaluate(async () => {
    (window as any).prismInboxFixture.denyPeople = true;
    await (window as any).prismInboxQuery.invalidateQueries({
      queryKey: ["vault", "inbox"],
    });
  });
  await expect(
    page.getByRole("button", { name: /Canonical recipient/ }),
  ).toHaveCount(0);
  await expect(page.getByText("No people with messages found.")).toBeVisible();
  await page.evaluate(async () => {
    (window as any).prismInboxFixture.denyPeople = false;
    await (window as any).prismInboxQuery.invalidateQueries({
      queryKey: ["vault", "inbox"],
    });
  });
  await expect(
    page.getByRole("button", { name: /Canonical recipient/ }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).prismInboxFixture.switchScope());
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Canonical recipient|Morgan|Hidden / }),
  ).toHaveCount(0);
});
test("recipient email still requires a fresh authorized detail read on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await people(page);
  await page.getByRole("button", { name: /Reverse recipient/ }).click();
  await page.evaluate(() => {
    (window as any).prismInboxFixture.denyDetail = true;
  });
  await page.getByRole("button", { name: /Recipient record/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Selected conversation" })
      .getByText("A real linked email body.", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).prismInboxFixture.sends),
  ).toEqual([]);
});
