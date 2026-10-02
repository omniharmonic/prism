import { expect, test, type Page } from "@playwright/test";
async function writes(page: Page) {
  return page.evaluate(() => (window as any).prismAccess.writes);
}
test("access invitation survives clipboard denial and preserves the confirmed role failure", async ({
  page,
}, info) => {
  await page.goto("/e2e-fixtures/workspace-access.html");
  await page
    .getByLabel("Email", { exact: true })
    .fill("new.person@example.test");
  await page
    .getByRole("combobox", { name: "Vault", exact: true })
    .selectOption("research");
  await page
    .getByRole("combobox", { name: "Document access", exact: true })
    .selectOption("suggest");
  await expect(
    page.getByText(/Use it only with trusted collaborators/),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Management role", exact: true })
    .selectOption("admin");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "role";
  });
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Vault access was granted",
  );
  expect((await writes(page)).map((value: any) => value.op)).toEqual([
    "access",
    "role",
  ]);
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveValue(
    /new.person/,
  );
  await page
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .click();
  await expect(page.getByText(/Copy was blocked/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Invitation link", { exact: true }).focus();
  expect(
    await page
      .getByLabel("Invitation link", { exact: true })
      .evaluate(
        (node: HTMLInputElement) => node.selectionEnd! - node.selectionStart!,
      ),
  ).toBeGreaterThan(10);
  await page.evaluate(() => {
    const c = (window as any).prismAccess;
    c.clipboardDenied = false;
    c.fail = "";
  });
  await page
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry management role", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await writes(page)).map((value: any) => value.op)).toEqual([
    "access",
    "role",
    "role",
  ]);
  await page
    .getByRole("heading", { name: "People & vault access", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("workspace-access-desktop.png"),
  });
});
test("failed removal retains explicit partial result and retries only management role", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-access.html");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "remove-role";
  });
  await page
    .getByRole("button", {
      name: "Remove avery@example.test from Personal notes",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "vault-wide grant was removed",
  );
  await expect(
    page.getByRole("button", { name: "Retry removing role", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "";
  });
  await page
    .getByRole("button", { name: "Retry removing role", exact: true })
    .click();
  expect((await writes(page)).map((value: any) => value.op)).toEqual([
    "remove-access",
    "remove-role",
    "remove-role",
  ]);
  await expect(
    page.getByRole("button", { name: "Retry removing role", exact: true }),
  ).toHaveCount(0);
});
test("scope switch after an access request prevents its queued management-role call and receipt", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-access.html");
  await page
    .getByLabel("Email", { exact: true })
    .fill("new.private@example.test");
  await page
    .getByRole("combobox", { name: "Management role", exact: true })
    .selectOption("admin");
  await page.evaluate(() => {
    (window as any).prismAccess.hold = "access";
  });
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add person", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(await writes(page)).toHaveLength(1);
  await page.evaluate(() => (window as any).prismAccess.switchScope());
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("");
  await page.evaluate(() => (window as any).prismAccess.release());
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(
    0,
  );
  expect((await writes(page)).map((value: any) => value.op)).toEqual([
    "access",
  ]);
});
test("member invite errors retain email and successful links can be copied manually", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/workspace-access.html?members&dark");
  await expect(
    page.getByText(/Manage people and grants for Personal notes/),
  ).toBeVisible();
  await page
    .getByLabel("Member email", { exact: true })
    .fill("new.member@example.test");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "member";
  });
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Fixture member failed");
  await expect(page.getByLabel("Member email", { exact: true })).toHaveValue(
    "new.member@example.test",
  );
  await page.evaluate(() => {
    const c = (window as any).prismAccess;
    c.fail = "";
    c.hold = "member";
  });
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.keyboard.press("Enter");
  expect(await writes(page)).toHaveLength(2);
  await page.evaluate(() => (window as any).prismAccess.release());
  await expect(
    page.getByLabel("Invitation link", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Copy invitation link", exact: true })
    .click();
  await expect(page.getByText(/Copy was blocked/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page
    .getByRole("heading", { name: "Members & sharing", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("workspace-members-phone-dark.png"),
  });
});
test("member role, tag grants, vault grants and revocation preserve existing payloads and error recovery", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-access.html?members");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "member";
  });
  await page
    .getByLabel("Role for avery@example.test", { exact: true })
    .selectOption("admin");
  await expect(page.getByRole("alert")).toContainText("Fixture member failed");
  await expect(
    page.getByLabel("Role for avery@example.test", { exact: true }),
  ).toHaveValue("member");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "";
  });
  await page
    .getByLabel("Role for avery@example.test", { exact: true })
    .selectOption("admin");
  await expect(
    page.getByLabel("Role for avery@example.test", { exact: true }),
  ).toHaveValue("admin");
  await page.getByLabel("Tag", { exact: true }).fill("projects");
  await page
    .getByLabel("Recipient email", { exact: true })
    .fill("reader@example.test");
  await page
    .getByRole("combobox", { name: "Tag access", exact: true })
    .selectOption("view");
  await page
    .getByRole("button", { name: "Share tagged notes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Share tagged notes", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Vault recipient email", { exact: true })
    .fill("reader@example.test");
  await page
    .getByRole("combobox", { name: "Vault access", exact: true })
    .selectOption("comment");
  await expect(
    page.getByText(/Anchored comments currently require/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Grant vault access", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Revoke grant for avery@example.test",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("No grants listed for this vault."),
  ).toBeVisible();
  expect(await writes(page)).toEqual([
    { op: "member", email: "avery@example.test", role: "admin" },
    { op: "member", email: "avery@example.test", role: "admin" },
    { op: "tag", tag: "projects", email: "reader@example.test", level: "view" },
    { op: "vault", email: "reader@example.test", level: "comment" },
    { op: "revoke", id: "grant-1" },
  ]);
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "remove-member";
  });
  await page
    .getByRole("button", {
      name: "Remove member avery@example.test",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText("remove-member failed");
  await page.evaluate(() => {
    (window as any).prismAccess.fail = "";
  });
  await page
    .getByRole("button", {
      name: "Remove member avery@example.test",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("No members listed for this vault."),
  ).toBeVisible();
});
test("guest and absent capability paths do not mount privileged access panels", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-access.html?guest");
  await expect(
    page.getByRole("heading", { name: "Workspace settings", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).prismAccess.accessReads +
        (window as any).prismAccess.memberReads,
    ),
  ).toBe(0);
  await expect(
    page.getByRole("button", { name: "Add person", exact: true }),
  ).toHaveCount(0);
  await page.goto("/e2e-fixtures/workspace-access.html?no-provider");
  await expect(page.getByRole("status")).toContainText("server owner");
});

test("member receipts and drafts are cleared on a vault switch while the invitation is pending", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/workspace-access.html?members");
  await page
    .getByLabel("Member email", { exact: true })
    .fill("new.oldscope@example.test");
  await page.evaluate(() => {
    (window as any).prismAccess.hold = "member";
  });
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.evaluate(() => (window as any).prismAccess.switchScope());
  await expect(page.getByLabel("Member email", { exact: true })).toHaveValue(
    "",
  );
  await page.evaluate(() => (window as any).prismAccess.release());
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/new.oldscope@example.test/)).toHaveCount(0);
});
