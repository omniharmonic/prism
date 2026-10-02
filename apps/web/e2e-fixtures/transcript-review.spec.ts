import { test, expect } from "@playwright/test";

test("review links recordings with explicit reasons and removes associations without deleting sources", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await expect(
    page.getByRole("button", {
      name: "Existing meeting recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.getByText("The title matches Design review.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Link Design review recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm link" }),
  ).toBeDisabled();
  await page
    .getByLabel("Reason for this change")
    .fill("This is the recording from our design review.");
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("status")).toContainText("Transcript linked");
  const writes = await page.evaluate(
    () => (window as any).prismTranscriptFixture.writes,
  );
  expect(writes[0]).toMatchObject({
    transcriptId: "candidate",
    action: "link",
    reason: "This is the recording from our design review.",
    meetingUpdatedAt: "meeting-v1",
    transcriptUpdatedAt: "candidate-v1",
    expectedRevision: 0,
  });
  expect(writes[0].requestId).toMatch(/^[\da-f-]{36}$/);
  expect(
    await page.evaluate(
      () => (window as any).prismTranscriptFixture.headers[0],
    ),
  ).toEqual({
    vault: "primary",
    workspace: "personal",
    actor: "user:owner@example.test",
  });
  await page
    .getByRole("button", {
      name: "Unlink Design review recording",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("This removes the meeting association.", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Reason for this change")
    .fill("The second recording is the correct one.");
  await page.getByRole("button", { name: "Confirm unlink" }).click();
  await expect(page.getByRole("status")).toContainText(
    "transcript is still in your vault",
  );
  expect(
    await page.evaluate(() =>
      (window as any).prismTranscriptFixture.writes.map(
        (write: any) => write.action,
      ),
    ),
  ).toEqual(["link", "unlink"]);
});

test("phone search and deliberate move confirmation fit without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.getByRole("button", { name: "Review matches" }).click();
  await page.getByRole("textbox", { name: "Search transcripts" }).fill("Other");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  await expect(
    page.getByRole("button", {
      name: "Link Design review recording",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Link Other recording", exact: true })
    .click();
  await page
    .getByLabel("Reason for this change")
    .fill("This recording belongs with the selected calendar event.");
  await expect(
    page.getByRole("button", { name: "Confirm link" }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: "Move this transcript" }).check();
  await expect(
    page.getByRole("button", { name: "Confirm link" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("transcript-review-phone.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("status")).toContainText("Transcript linked");
});

test("failed and pending decisions retain the same request identity, draft, and locked pending state", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.getByRole("button", { name: "Review matches" }).click();
  await page
    .getByRole("button", { name: "Link Design review recording", exact: true })
    .click();
  await page
    .getByLabel("Reason for this change")
    .fill("Keep this reason during a network failure.");
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.fail = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByLabel("Reason for this change")).toHaveValue(
    "Keep this reason during a network failure.",
  );
  await page.evaluate(() => {
    const fixture = (window as any).prismTranscriptFixture;
    fixture.fail = false;
    fixture.pending = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("status")).toContainText("still updating");
  await expect(page.getByLabel("Reason for this change")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Unlink Existing meeting recording" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.pending = false;
  });
  await page.getByRole("button", { name: "Retry pending decision" }).click();
  await expect(page.getByRole("status")).toContainText("Transcript linked");
  expect(
    await page.evaluate(
      () =>
        new Set(
          (window as any).prismTranscriptFixture.writes.map(
            (write: any) => write.requestId,
          ),
        ).size,
    ),
  ).toBe(1);
});

test("conflict reload retains reason but refreshes revisions and request identity", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.getByRole("button", { name: "Review matches" }).click();
  await page
    .getByRole("button", { name: "Link Design review recording", exact: true })
    .click();
  await page
    .getByLabel("Reason for this change")
    .fill("Reviewed the full recording.");
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.conflict = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "changed in another window",
  );
  await page.getByRole("button", { name: "Reload records" }).click();
  await expect(page.getByLabel("Reason for this change")).toHaveValue(
    "Reviewed the full recording.",
  );
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("status")).toContainText("Transcript linked");
  const writes = await page.evaluate(
    () => (window as any).prismTranscriptFixture.writes,
  );
  expect(writes[1].requestId).not.toBe(writes[0].requestId);
  expect(writes[1].meetingUpdatedAt).toBe("meeting-v2");
});

test("read-only access hides mutations and a late decision cannot populate another audience", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html?readonly");
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.getByRole("button", { name: /^(Link|Unlink) / }),
  ).toHaveCount(0);
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.getByRole("button", { name: "Link Read-only recording" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Link Design review recording", exact: true })
    .click();
  await page
    .getByLabel("Reason for this change")
    .fill("Private reason from the previous workspace.");
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.hold = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await page.evaluate(async () => {
    const fixture = (window as any).prismTranscriptFixture;
    await fixture.switchScope();
    fixture.release();
  });
  await expect(page.getByLabel("Reason for this change")).toHaveCount(0);
  await expect(
    page.getByText("Transcript linked to this meeting.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Existing meeting recording",
      exact: true,
    }),
  ).toHaveCount(0);
});
