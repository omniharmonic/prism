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
  await expect(
    page.getByRole("status").filter({ hasText: "Transcript linked" }),
  ).toBeVisible();
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
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "transcript is still in your vault" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("status").filter({ hasText: "Transcript linked" }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Retry pending decision" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "still updating" }),
  ).toBeVisible();
  await expect(page.getByLabel("Reason for this change")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Unlink Existing meeting recording" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.pending = false;
  });
  await page.getByRole("button", { name: "Retry pending decision" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Transcript linked" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("status").filter({ hasText: "Transcript linked" }),
  ).toBeVisible();
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
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as any).prismTranscriptFixture.release,
      ),
    )
    .toBe("function");
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

async function prepareDecision(page: import("@playwright/test").Page) {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.getByRole("button", { name: "Review matches" }).click();
  await page
    .getByRole("button", { name: "Link Design review recording", exact: true })
    .click();
  await page
    .getByLabel("Reason for this change")
    .fill("Reviewed against the original conversation.");
}

for (const loseAppliedResponse of [false, true]) {
  test(`reload recovers exact request without automatic write (${loseAppliedResponse ? "applied response lost" : "pending"})`, async ({
    page,
  }) => {
    await prepareDecision(page);
    await page.evaluate((lost) => {
      Object.assign((window as any).prismTranscriptFixture, {
        pending: !lost,
        loseAppliedResponse: lost,
      });
    }, loseAppliedResponse);
    await page.getByRole("button", { name: "Confirm link" }).click();
    await expect(
      page.getByRole("button", { name: "Retry pending decision" }),
    ).toBeEnabled();
    const before = await page.evaluate(() => {
      const f = (window as any).prismTranscriptFixture;
      return {
        raw: f.rawWrites[0],
        stored: localStorage.getItem(f.receiptKey()),
      };
    });
    expect(JSON.parse(before.stored!).body).toBe(before.raw);
    await page.reload();
    await expect(
      page.getByText(/No change was sent automatically/),
    ).toBeVisible();
    await expect(page.getByLabel("Reason for this change")).toHaveValue(
      "Reviewed against the original conversation.",
    );
    expect(
      await page.evaluate(
        () => (window as any).prismTranscriptFixture.writes.length,
      ),
    ).toBe(1);
    await page.getByRole("button", { name: "Retry pending decision" }).click();
    await expect(
      page.getByText("Transcript linked to this meeting.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as any).prismTranscriptFixture.rawWrites,
      ),
    ).toEqual([before.raw, before.raw]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          (window as any).prismTranscriptFixture.receiptKey(),
        ),
      ),
    ).toBeNull();
    await expect(
      page.getByRole("button", {
        name: /^Design review recording/,
      }),
    ).toHaveCount(1);
  });
}

for (const [status, code, text, terminal] of [
  [401, "unauthorized", "Sign in again", false],
  [403, "forbidden", "no longer have permission", false],
  [404, "not_found", "no longer available to you", false],
  [409, "vault_unavailable", "vault is unavailable", false],
  [409, "write_actor_changed", "signed-in account changed", false],
  [422, "request_reused", "already used for a different decision", true],
  [400, "bad_request", "decision was not accepted", true],
  [415, "unsupported_media_type", "decision was not accepted", true],
] as const) {
  test(`${status} ${code} shows precise recovery and ${terminal ? "clears terminal" : "retains unresolved"} receipt`, async ({
    page,
  }) => {
    await prepareDecision(page);
    await page.evaluate(
      ({ status, code }) => {
        (window as any).prismTranscriptFixture.responseError = { status, code };
      },
      { status, code },
    );
    await page.getByRole("button", { name: "Confirm link" }).click();
    await expect(page.getByRole("alert")).toContainText(text);
    await expect(
      page.getByRole("button", {
        name: terminal ? "Confirm link" : "Retry pending decision",
      }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          localStorage.getItem(
            (window as any).prismTranscriptFixture.receiptKey(),
          ) !== null,
      ),
    ).toBe(!terminal);
    await expect(page.getByLabel("Reason for this change")).toHaveValue(
      "Reviewed against the original conversation.",
    );
  });
}

test("superseded receipt clears and reloads without automatically creating a new decision", async ({
  page,
}) => {
  await prepareDecision(page);
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.responseError = {
      status: 409,
      code: "superseded",
    };
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "newer decision replaced",
  );
  await expect(
    page.getByRole("button", { name: "Confirm link" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as any).prismTranscriptFixture.writes.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem((window as any).prismTranscriptFixture.receiptKey()),
    ),
  ).toBeNull();
});

test("rate limit honors Retry-After and preserves byte-identical decision", async ({
  page,
}) => {
  await prepareDecision(page);
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.responseError = {
      status: 429,
      code: "rate_limited",
      retryAfter: 2,
    };
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Too many transcript requests",
  );
  await expect(
    page.getByRole("button", { name: "Retry pending decision" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reload records" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.responseError = null;
  });
  await expect(
    page.getByRole("button", { name: "Retry pending decision" }),
  ).toBeEnabled({ timeout: 4000 });
  await page.getByRole("button", { name: "Retry pending decision" }).click();
  await expect(
    page.getByText("Transcript linked to this meeting.", { exact: true }),
  ).toBeVisible();
  const writes = await page.evaluate(
    () => (window as any).prismTranscriptFixture.rawWrites,
  );
  expect(writes[1]).toBe(writes[0]);
});

test("GET failures remain visible with explicit retry and no mutations", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await expect(
    page.getByRole("button", { name: "Review matches" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.readError = {
      status: 404,
      code: "not_found",
    };
  });
  await page.getByRole("button", { name: "Review matches" }).click();
  await page
    .getByRole("textbox", { name: "Search transcripts" })
    .fill("new query");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "no longer available to you",
  );
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.readError = null;
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).prismTranscriptFixture.writes.length,
    ),
  ).toBe(0);
});

test("denied persistent storage warns honestly and retries from memory", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key.startsWith("prism:transcript-decision:"))
        throw new DOMException("Blocked", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith("prism:transcript-decision:"))
        throw new DOMException("Blocked", "SecurityError");
      return set.call(this, key, value);
    };
  });
  await prepareDecision(page);
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.fail = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(
    page.getByText(/Keep it open or copy the retry details/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show retry details to copy" })
    .click();
  await expect(page.getByLabel("Retry details")).toHaveValue(
    /Reviewed against the original conversation\./,
  );
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.fail = false;
  });
  await page.getByRole("button", { name: "Retry pending decision" }).click();
  await expect(
    page.getByText("Transcript linked to this meeting.", { exact: true }),
  ).toBeVisible();
  const writes = await page.evaluate(
    () => (window as any).prismTranscriptFixture.rawWrites,
  );
  expect(writes[1]).toBe(writes[0]);
});

test("unreadable receipt is never silently replaced by a new decision", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html");
  await page.evaluate(() =>
    localStorage.setItem(
      (window as any).prismTranscriptFixture.receiptKey(),
      "{broken",
    ),
  );
  await page.reload();
  await expect(
    page.getByText(/stored decision cannot be read safely/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.getByRole("button", {
      name: "Link Design review recording",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as any).prismTranscriptFixture.writes.length,
    ),
  ).toBe(0);
});

test("another view cannot replace an unresolved request with its own draft", async ({
  page,
  context,
}) => {
  await prepareDecision(page);
  const second = await context.newPage();
  await prepareDecision(second);
  await second
    .getByLabel("Reason for this change")
    .fill("Different draft in another window.");
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.pending = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(
    page.getByRole("button", { name: "Retry pending decision" }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "Confirm link" }).click();
  await expect(
    second.getByText(/Another view already saved a decision/),
  ).toBeVisible();
  await expect(second.getByLabel("Reason for this change")).toHaveValue(
    "Reviewed against the original conversation.",
  );
  expect(
    await second.evaluate(
      () => (window as any).prismTranscriptFixture.writes.length,
    ),
  ).toBe(0);
});

test("date-only legacy timestamps keep their local date without inventing a time", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html?dates");
  await page.getByRole("button", { name: "Review matches" }).click();
  await expect(
    page.getByRole("button", { name: /^Design review recording/ }),
  ).toContainText("Oct 2, 2026");
  await expect(
    page.getByRole("button", { name: /^Design review recording/ }),
  ).not.toContainText("PM");
});

test("provider absence keeps stored links and path aliases never issue review requests", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/transcript-review.html?legacy");
  await expect(
    page.getByRole("button", { name: "Existing meeting recording" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismTranscriptFixture.reads),
  ).toEqual([]);
  await page.goto("/e2e-fixtures/transcript-review.html?alias");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismTranscriptFixture.reads),
  ).toEqual([]);
});

for (const phone of [false, true]) {
  test(`actual CalendarDashboard exposes meeting records and real note navigation (${phone ? "phone dark" : "desktop"})`, async ({
    page,
  }, info) => {
    await page.setViewportSize(
      phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.clock.setFixedTime(new Date("2026-10-02T16:00:00Z"));
    await page.goto(
      "/e2e-fixtures/transcript-review.html?calendar" + (phone ? "&dark" : ""),
    );
    if (!phone)
      await page.getByRole("button", { name: "Week", exact: true }).click();
    await page
      .getByRole("button", { name: /Design review/ })
      .first()
      .click();
    await expect(
      page.getByRole("region", { name: "Meeting transcripts" }),
    ).toContainText("Existing meeting recording");
    await expect(page.getByText("Morgan Lee")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(
        phone
          ? "calendar-records-phone-dark.png"
          : "calendar-records-desktop.png",
      ),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Meeting Notes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).prismTranscriptUI.getState().activeTabId,
        ),
      )
      .toBe("tab-meeting");
  });
}

test("without Web Locks new decisions stop safely while records remain readable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", { value: undefined }),
  );
  await prepareDecision(page);
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(
    page.getByText(/Viewing and opening recordings still work/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Existing meeting recording", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).prismTranscriptFixture.opens),
  ).toEqual(["linked"]);
  expect(
    await page.evaluate(() => (window as any).prismTranscriptFixture.writes),
  ).toEqual([]);
});

test("revoked access after reload retains receipt but prevents write retries", async ({
  page,
}) => {
  await prepareDecision(page);
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.pending = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(
    page.getByRole("button", { name: "Retry pending decision" }),
  ).toBeEnabled();
  await page.goto("/e2e-fixtures/transcript-review.html?readonly");
  await expect(
    page.getByText(/Permission to manage this meeting is required/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry pending decision" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as any).prismTranscriptFixture.writes.length,
    ),
  ).toBe(1);
});

test("GET rate limit delays explicit retry and reason input is bounded", async ({
  page,
}) => {
  await prepareDecision(page);
  await expect(page.getByLabel("Reason for this change")).toHaveAttribute(
    "maxlength",
    "500",
  );
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.readError = {
      status: 429,
      code: "rate_limited",
      retryAfter: 1,
    };
  });
  await page.getByRole("button", { name: "Reload records" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Too many transcript requests",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.readError = null;
  });
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({
    timeout: 3000,
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Reason for this change")).toHaveValue(
    "Reviewed against the original conversation.",
  );
});

test("cancel after a stale decision still offers recovery without trapping the meeting", async ({
  page,
}) => {
  await prepareDecision(page);
  await page.evaluate(() => {
    (window as any).prismTranscriptFixture.conflict = true;
  });
  await page.getByRole("button", { name: "Confirm link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "changed in another window",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Reload records" }).click();
  await expect(
    page.getByRole("button", {
      name: "Link Design review recording",
      exact: true,
    }),
  ).toBeEnabled();
});
