import { test, expect } from "@playwright/test";
const fixture = "/e2e-fixtures/connections.html";
test("actual workspace settings presents honest account rows and preserved processing evidence", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(fixture);
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage Matrix", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Saved credentials do not confirm a successful sync.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Manage / })).toHaveCount(8);
  await page.screenshot({ path: info.outputPath("connections-desktop.png") });
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  await expect(page.getByLabel("Homeserver", { exact: false })).toHaveValue(
    "https://matrix.example.test",
  );
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "",
  );
  await expect(
    page.getByRole("button", { name: "Save credentials" }),
  ).toBeDisabled();

  await page.getByRole("tab", { name: "Processing", exact: true }).click();
  await expect(
    page.getByText("Transcript linking", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(/inferred from the newest vault note/),
  ).toBeVisible();
  await expect(
    page.getByText(/Calendar source has not reported recent notes/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes),
  ).toEqual([]);
});
test("Proton detection sends no password and requires explicit trust before saving", async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole("button", { name: "Manage Proton Mail Bridge" }).click();
  await page
    .getByLabel("Bridge password", { exact: false })
    .fill("fixture-bridge-secret");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Port", { exact: true }).fill("2143");
  await page.getByRole("button", { name: "Detect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save credentials" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I confirm this is my Proton Mail Bridge" })
    .check();
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Proton Mail Bridge credentials saved",
  );
  const writes = await page.evaluate(
    () => (window as any).prismConnections.writes,
  );
  expect(writes[0]).toMatchObject({
    op: "detect",
    kind: "proton-bridge",
    action: "detect-cert",
    body: { host: "127.0.0.1", port: 2143, security: "starttls" },
  });
  expect(writes[0].body.password).toBeUndefined();
  expect(writes[1]).toMatchObject({
    op: "save",
    kind: "proton-bridge",
    body: {
      username: "bridge@example.test",
      password: "fixture-bridge-secret",
      certSha256: "a".repeat(64),
      port: 2143,
    },
  });
  await page.getByRole("button", { name: "Manage Proton Mail Bridge" }).click();
  await expect(
    page.getByLabel("Bridge password", { exact: false }),
  ).toHaveValue("");
});
test("credential failure retains draft and optional scope values; sync and removal keep exact seams", async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole("button", { name: "Manage ClickUp" }).click();
  await page
    .getByLabel("API key", { exact: false })
    .fill("fixture-clickup-secret");
  await page.evaluate(() => {
    (window as any).prismConnections.fail = "save";
  });
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture save failed");
  await expect(page.getByLabel("API key", { exact: false })).toHaveValue(
    "fixture-clickup-secret",
  );
  await expect(
    page.getByRole("checkbox", { name: "Only tasks assigned to me" }),
  ).not.toBeChecked();
  await page.evaluate(() => {
    (window as any).prismConnections.fail = "";
  });
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByRole("status")).toContainText(
    "ClickUp credentials saved",
  );
  const saves = await page.evaluate(
    () => (window as any).prismConnections.writes,
  );
  expect(saves[1].body).toEqual({
    apiKey: "fixture-clickup-secret",
    teamId: "team-7",
    spaceIds: "space-a,space-b",
    assignedOnly: false,
  });
  await page.getByRole("button", { name: "Manage ClickUp" }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "3 imported · 1 updated",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).prismConnections.writes.filter(
        (w: any) => w.op === "remove",
      ),
    ),
  ).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "ClickUp credentials removed",
  );
});
test("unknown per-kind state cannot be mistaken for absent credentials or edited", async ({
  page,
}) => {
  await page.goto(fixture + "?unavailable");
  const row = page.getByRole("button", { name: "Manage Matrix", exact: true });
  await expect(row).toContainText("Status unavailable");
  await expect(row).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Manage ClickUp" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).prismConnections.failedKinds = [];
  });
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect(row).toBeEnabled();
  await expect(row).toContainText("Credentials saved");
});
test("vault switch clears private credential draft and suppresses an old refresh", async ({
  page,
}) => {
  await page.goto(fixture);
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  await page.getByLabel("Access token", { exact: false }).fill("private-draft");
  await page.evaluate(() => {
    (window as any).prismConnections.hold = "read:matrix";
  });
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).prismConnections.release),
    )
    .toBe("function");
  await page.evaluate(() => {
    const f = (window as any).prismConnections;
    f.switchScope();
    f.release();
  });
  const row = page.getByRole("button", { name: "Manage Matrix", exact: true });
  await expect(row).toContainText("Not configured");
  await expect(page.getByLabel("Access token", { exact: false })).toHaveCount(
    0,
  );
  await row.click();
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "",
  );
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes),
  ).toEqual([]);
});
test("inner non-owner admin has vault integrations but no owner host controls; outer member gate stays intact", async ({
  page,
}) => {
  await page.goto(fixture + "?admin");
  await expect(
    page.getByRole("button", { name: "Manage Matrix", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("tab", { name: "Server operations" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.goto(fixture + "?member");
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toHaveCount(0);
});
test("server operator actions preserve confirmation, dry run, notifications and write-only rotation", async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole("tab", { name: "Server operations" }).click();
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes),
  ).toEqual([]);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Tunnel stop requested");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revoke all + notify" }).click();
  await expect(page.getByRole("status")).toContainText("notified 1");
  const legacy = await page.evaluate(() =>
    (window as any).prismConnections.writes.filter(
      (w: any) => w.op === "legacy",
    ),
  );
  expect(legacy.map((w: any) => w.body)).toEqual([
    { notify: true, dryRun: true },
    { notify: true, dryRun: false },
  ]);
  await page.getByTitle("Replace this vault's token (write-only)").click();
  await page
    .getByPlaceholder("new token — never shown again")
    .fill("fixture-vault-token");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("replaced");
  await expect(
    page.getByPlaceholder("new token — never shown again"),
  ).toHaveCount(0);
});
test("phone dark connections and credential forms fit with touch-sized controls", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture + "?dark");
  await expect(
    page.getByRole("button", { name: "Manage Matrix", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("connections-phone-dark.png"),
  });
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await page
      .getByRole("button", { name: "Save credentials" })
      .boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await page
    .getByRole("button", { name: "Save credentials" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("connections-credentials-phone-dark.png"),
  });
});

test("connection sections support arrow keys and retain a same-vault draft", async ({
  page,
}) => {
  await page.goto(fixture);
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  await page
    .getByLabel("Access token", { exact: false })
    .fill("unsaved-fixture-secret");
  await page.getByRole("tab", { name: "Accounts", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Processing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Server operations" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "unsaved-fixture-secret",
  );
});

test("pending credential saves cannot duplicate or change fields and failures stay actionable", async ({
  page,
}) => {
  await page.goto(fixture);
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  await page
    .getByLabel("Access token", { exact: false })
    .fill("fixture-secret");
  await page.evaluate(() => {
    Object.assign((window as any).prismConnections, {
      hold: "save",
      fail: "save",
    });
  });
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Access token", { exact: false }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).prismConnections.release());
  await expect(page.getByRole("alert")).toContainText("Fixture save failed");
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "fixture-secret",
  );
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes.length),
  ).toBe(1);
});

test("failed status refresh disables an open form without losing its same-scope draft", async ({
  page,
}) => {
  await page.goto(fixture);
  await page
    .getByRole("button", { name: "Manage Matrix", exact: true })
    .click();
  await page
    .getByLabel("Access token", { exact: false })
    .fill("same-scope-draft");
  await page.evaluate(() => {
    (window as any).prismConnections.failedKinds = ["matrix"];
  });
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect(
    page.getByRole("button", { name: "Close Matrix", exact: true }),
  ).toContainText("Status unavailable");
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "same-scope-draft",
  );
  await expect(
    page.getByRole("button", { name: "Save credentials" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).prismConnections.failedKinds = [];
  });
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect(
    page.getByRole("button", { name: "Save credentials" }),
  ).toBeEnabled();
  await expect(page.getByLabel("Access token", { exact: false })).toHaveValue(
    "same-scope-draft",
  );
});

test("ingress and server sender configuration retain their explicit operator payloads", async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole("tab", { name: "Server operations" }).click();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "2. Add ingress rules & restart tunnel" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Routed: research.example.test",
  );
  const sender = page.getByPlaceholder("Prism <prism@example.test>");
  await sender.fill("Prism Team <team@example.test>");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("restart the server");
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes),
  ).toEqual([
    { op: "ingress", vault: "personal" },
    {
      op: "config",
      key: "MAGIC_FROM",
      value: "Prism Team <team@example.test>",
      vault: "personal",
    },
  ]);
});

test("a late legacy-token dry run cannot prompt or revoke after a vault switch", async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole("tab", { name: "Server operations" }).click();
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await page.evaluate(() => {
    (window as any).prismConnections.hold = "legacy";
  });
  await page.getByRole("button", { name: "Revoke all + notify" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).prismConnections.release),
    )
    .toBe("function");
  await page.evaluate(() => {
    const f = (window as any).prismConnections;
    f.switchScope();
    f.release();
  });
  await expect(
    page.getByRole("button", { name: "Manage Matrix", exact: true }),
  ).toContainText("Not configured");
  expect(dialogs).toBe(0);
  expect(
    await page.evaluate(() =>
      (window as any).prismConnections.writes.map((w: any) => w.body),
    ),
  ).toEqual([{ notify: true, dryRun: true }]);
});

test("phone server operations preserve readable fields without overflowing the viewport", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture);
  await page.getByRole("tab", { name: "Server operations" }).click();
  await page.getByTitle("Replace this vault's token (write-only)").click();
  await expect(
    page.getByLabel("New access token for Personal notes"),
  ).toBeVisible();
  await page.getByLabel("Email 'from' address").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("connections-server-phone.png"),
  });
  expect(
    await page.evaluate(() => (window as any).prismConnections.writes),
  ).toEqual([]);
});
