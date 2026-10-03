import { test, expect } from "@playwright/test";
async function open(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/e2e-fixtures/sharing.html${query}`);
  await page
    .getByRole("button", { name: "Share fixture", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Share document" }),
  ).toBeVisible();
  await expect(
    page.getByText("A calmer place to think", { exact: true }),
  ).toBeVisible();
}
test("sharing separates people, links, publishing and peer sync, fits a phone and contains keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(
    page.getByRole("button", { name: "Create link", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Tag grants · inactive while private"),
  ).toBeVisible();
  await page.getByLabel("Collaborator permission").selectOption("comment");
  await expect(
    page.getByText(/Anchored comments currently require/),
  ).toBeVisible();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/sharing-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Share fixture", exact: true }),
  ).toBeFocused();
});
test("failed changes retain drafts and grants; a pending operation cannot be duplicated", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Invite people", { exact: true }).fill("new@example.test");
  await page.evaluate(() => {
    (window as any).prismSharingFixture.failNext = true;
  });
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't add");
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue(
    "new@example.test",
  );
  await page.evaluate(() => {
    (window as any).prismSharingFixture.hold = true;
  });
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Invite", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Collaborator permission")).toBeDisabled();
  await page.evaluate(() => {
    const c = (window as any).prismSharingFixture;
    c.hold = false;
    c.release();
  });
  await expect(
    page.getByText("new@example.test", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).prismSharingFixture.calls.filter(
          (c: any) => c.kind === "setPerson",
        ).length,
    ),
  ).toBe(2);
  await page.evaluate(() => {
    (window as any).prismSharingFixture.failNext = true;
  });
  await page
    .getByRole("button", { name: "Remove access for alex@example.test" })
    .click();
  await expect(page.getByRole("alert")).toContainText("Couldn't remove");
  await expect(
    page.getByText("alex@example.test", { exact: true }),
  ).toBeVisible();
});
test("links use the selected expiry, clipboard failure stays explicit and failed revocation retains the link", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("tab", { name: "Link access", exact: true }).click();
  await page.getByLabel("Link permission").selectOption("suggest");
  await page.getByLabel("Link expires after").selectOption("7");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(Error("denied")) },
    });
  });
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByLabel("link new-link", { exact: true })).toHaveValue(
    /fixture=2/,
  );
  await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).prismSharingFixture.calls.find(
          (c: any) => c.kind === "createLink",
        ).args,
    ),
  ).toEqual(["private", "suggest", 7]);
  await page.evaluate(() => {
    (window as any).prismSharingFixture.failNext = true;
  });
  await page
    .getByRole("button", { name: "Revoke link", exact: true })
    .last()
    .click();
  await expect(page.getByRole("alert")).toContainText("Couldn't revoke");
  await expect(
    page.getByRole("button", { name: "Revoke link", exact: true }),
  ).toHaveCount(2);
});
test("scoped sharers see only their available roles and no link, publication, sync or visibility controls", async ({
  page,
}) => {
  await open(page, "?scoped");
  await expect(
    page.getByLabel("Collaborator permission").locator("option"),
  ).toHaveCount(1);
  for (const name of ["Link access", "Publish", "Sync"])
    await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use workspace access", exact: true }),
  ).toHaveCount(0);
});
test("changing audience closes the modal and ignores a delayed sharing result", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Invite people", { exact: true }).fill("new@example.test");
  await page.evaluate(() => {
    (window as any).prismSharingFixture.hold = true;
  });
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.evaluate(() => {
    (window as any).prismSharingFixture.switchScope();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as any).prismSharingFixture;
    c.hold = false;
    c.release();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("publishing and peer sync retain their independent controls and failure recovery", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("tab", { name: "Publish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Publish collection", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Site password (optional)").fill("fixture-password");
  await page
    .getByRole("button", { name: "Publish collection", exact: true })
    .click();
  await expect(
    page.getByText("Published · password required", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Publish collection", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Sync", exact: true }).click();
  await page.getByLabel("Peer permission").selectOption("view");
  await page.getByRole("button", { name: "Start sync", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Sync started");
  expect(
    await page.evaluate(
      () =>
        (window as any).prismSharingFixture.calls.find(
          (c: any) => c.kind === "sync",
        ).args,
    ),
  ).toEqual(["private", "private-peer", "view"]);
});

test("real sharing transport pins its actor and rejects responses from a previous vault", async ({
  page,
}) => {
  const headers: Record<string, string>[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        email: "owner@example.test",
        vaultId: "primary",
        workspace: { id: "workspace-a" },
      },
    }),
  );
  await page.route("**/acl/notes/same", async (route) => {
    headers.push(route.request().headers());
    await delayed;
    await route.fulfill({
      json: {
        note: { id: "same", title: "Old vault secret" },
        people: [],
        links: [],
        tagAccess: [],
      },
    });
  });
  await page.goto("/e2e-fixtures/sharing.html");
  await page.evaluate(() => (window as any).prismSharingFixture.hostReady());
  await page.evaluate(() => {
    (window as any).hostResult = (window as any).prismSharingFixture
      .hostRead()
      .then(
        () => "leaked",
        (e: Error) => e.message,
      );
  });
  await expect.poll(() => headers.length).toBe(1);
  expect(headers[0]!["x-prism-vault"]).toBe("primary");
  expect(headers[0]!["x-prism-workspace"]).toBe("workspace-a");
  expect(headers[0]!["x-prism-write-actor"]).toBe("user:owner@example.test");
  await page.evaluate(() =>
    (window as any).prismSharingFixture.switchHostVault(),
  );
  release();
  expect(await page.evaluate(() => (window as any).hostResult)).toContain(
    "Workspace or account changed",
  );
  expect(
    await page.evaluate(() =>
      (window as any).prismSharingFixture.hostWrite().then(
        () => "unexpected",
        (e: Error) => e.message,
      ),
    ),
  ).toContain("Reconnect");
});

test("custom permissions remain explicit until deliberately replaced by a role", async ({
  page,
}) => {
  await open(page, "?custom");
  const control = page.getByLabel("Permission for alex@example.test", {
    exact: true,
  });
  await expect(control).toHaveValue("custom");
  await expect(page.getByText(/Custom: view, edit, share/)).toBeVisible();
  await control.selectOption("view");
  await expect(control).toHaveValue("view");
  await expect(page.getByText(/Custom: view, edit, share/)).toHaveCount(0);
});

test("real workspace sharing keeps the dialog and invitation draft across responsive headers", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/sharing.html?toolbar");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Invite people", { exact: true }).fill("draft@example.test");
  await page.getByLabel("Collaborator permission").selectOption("suggest");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog", { name: "Share document" }),
  ).toBeVisible();
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue(
    "draft@example.test",
  );
  await expect(page.getByLabel("Collaborator permission")).toHaveValue(
    "suggest",
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue(
    "draft@example.test",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Share", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Invite people", { exact: true }).fill("old-audience@example.test");
  await page.evaluate(() => (window as any).prismSharingFixture.switchScope());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByLabel("Invite people", { exact: true })).toHaveValue("");
});

test("suggest permissions describe server-enforced review, with no trusted-collaborator caveat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByText(/trusted collaborators/)).toHaveCount(0);
  await page.getByLabel("Collaborator permission").selectOption("suggest");
  await expect(
    page.locator("form").getByText(/wait for an editor’s review — they can’t change the page directly/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Link access", exact: true }).click();
  await page.getByLabel("Link permission").selectOption("suggest");
  await expect(page.getByText(/can’t change the page directly/)).toBeVisible();
  await page.getByRole("tab", { name: "Sync", exact: true }).click();
  await page.getByLabel("Peer permission").selectOption("suggest");
  await expect(page.getByText(/peers have no suggestion path yet/)).toBeVisible();
  await expect(page.getByText(/trusted collaborators/)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).prismSharingFixture.calls.filter((c: any) =>
        ["setPerson", "createLink", "sync"].includes(c.kind),
      ),
    ),
  ).toEqual([]);
});
