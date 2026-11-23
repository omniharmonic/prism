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
    // The legacy fallback (lib/clipboard.ts) is refused too: nothing reaches the clipboard.
    document.execCommand = () => false;
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
// NP-CO-08
test("Publish tab: explains per-tag publishing, previews the collection and hands off to the Publishing studio", async ({ page }) => {
  await open(page, "?tree");
  await page.getByRole("tab", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share document" });
  // Per tag, not per page — said in plain words.
  await expect(dialog).toContainText("Prism publishes by tag, not page by page");
  await expect(dialog).toContainText("every page tagged #prism becomes a page of one read-only site");
  // Preview: the pages that carry the tag (and only those), this page marked.
  // Labelled for what it is: the viewer's own view of the tag, not the published set.
  const preview = dialog.getByRole("group", { name: "Pages you can see tagged prism" });
  await expect(preview).toContainText("12 pages you can see with #prism");
  await expect(preview.getByRole("listitem")).toHaveCount(8);
  await expect(preview.locator('li[aria-current="true"]')).toContainText("A calmer place to think");
  await expect(preview.locator('li[aria-current="true"]')).toContainText("this page");
  await expect(preview).not.toContainText("Monday");
  await preview.getByRole("button", { name: "Show all 12" }).click();
  await expect(preview.getByRole("listitem")).toHaveCount(12);
  await expect(preview).toContainText("This is your own view of the tag, not the published set");
  await expect(preview).toContainText("The Publishing studio shows exactly what goes live.");
  // Hand-off: the studio opens (Workspace settings → Publish) and the dialog closes; nothing was published from here.
  await dialog.getByRole("button", { name: "Review and publish in the Publishing studio" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => { const s = (window as any).prismSharingUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("network");
  expect(await page.evaluate(() => (window as any).prismSharingFixture.calls.filter((c: any) => c.kind === "publish").length)).toBe(0);
});

test("Publish tab: a published collection is managed in the studio; without a data context the hand-off is still offered", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share document" });
  await expect(dialog.getByRole("group", { name: "Pages you can see tagged prism" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Review and publish in the Publishing studio" })).toBeVisible();
  await dialog.getByRole("button", { name: "Publish collection", exact: true }).click();
  await dialog.getByRole("group", { name: "Confirm publishing" }).getByRole("button", { name: "Publish site" }).click();
  await expect(dialog.getByRole("button", { name: "Manage this site in the Publishing studio" })).toBeVisible();
});

// NP-CO-08, every clause in ONE flow inside Share → Publish: reachable from Share; says publishing is per tag;
// previews what would go out (counted as this viewer sees it); publishes and unpublishes behind a confirm step
// that says what happens; shows the public address; the password option; and the Publishing studio — the same
// site, the same operation — is one click away in every state (no dead end).
test("NP-CO-08: Share → Publish is one flow — per tag, preview, confirm, address, password, unpublish, studio", async ({ page }) => {
  await open(page, "?tree");
  const dialog = page.getByRole("dialog", { name: "Share document" });
  const calls = (kind: string) => page.evaluate((kind) => (window as any).prismSharingFixture.calls.filter((c: any) => c.kind === kind).map((c: any) => c.args), kind);
  await dialog.getByRole("tab", { name: "Publish", exact: true }).click(); // reachable from Share
  await expect(dialog).toContainText("Prism publishes by tag, not page by page"); // per tag
  await expect(dialog.getByRole("group", { name: "Pages you can see tagged prism" })).toContainText("12 pages you can see with #prism"); // preview
  const site = dialog.getByRole("group", { name: "Site for prism" });
  await expect(site).toHaveAttribute("data-published", "false");
  await expect(site).toContainText("Not published");
  await expect(dialog.getByRole("button", { name: "Review and publish in the Publishing studio" })).toBeVisible();

  // Publish: nothing happens until the confirm step, which names what goes out and who can read it.
  await site.getByRole("button", { name: "Publish collection", exact: true }).click();
  const confirm = site.getByRole("group", { name: "Confirm publishing" });
  await expect(confirm).toContainText("Publish #prism to the web?");
  await expect(confirm).toContainText("the 12 pages you can see with #prism (private pages are left out)");
  await expect(confirm).toContainText("by anyone who has the address,");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await calls("publish")).toEqual([]);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await calls("publish")).toEqual([]);
  // With a password the confirm step says so. A failed publish says so and leaves the step open: try again.
  await site.getByLabel("Site password (optional)").fill("fixture-password");
  await site.getByRole("button", { name: "Publish collection", exact: true }).click();
  await expect(confirm).toContainText("by anyone who has the address and the password you set");
  await page.evaluate(() => { (window as any).prismSharingFixture.failNext = true; });
  await confirm.getByRole("button", { name: "Publish site" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(site).toHaveAttribute("data-published", "false");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Publish site" }).click();
  expect(await calls("publish")).toEqual([["prism", { password: "fixture-password" }], ["prism", { password: "fixture-password" }]]);

  // Published: the public address (a link + copy), what is live, who can read it.
  await expect(site).toHaveAttribute("data-published", "true");
  await expect(site.getByRole("heading", { name: "Published · password required" })).toBeVisible();
  await expect(site.getByRole("link", { name: "https://prism.example.test/wiki" })).toHaveAttribute("href", "https://prism.example.test/wiki");
  await expect(site.getByRole("link", { name: "https://prism.example.test/wiki" })).toHaveAttribute("target", "_blank");
  await expect(site.getByRole("button", { name: "Copy published site" })).toBeVisible();
  await expect(site).toContainText("2 pages are live. Readers need the site password.");
  await expect(site.getByLabel("Update site password")).toHaveValue(""); // the password is not kept in the form
  await expect(dialog.getByRole("button", { name: "Manage this site in the Publishing studio" })).toBeVisible();
  // Password option: remove it, set another.
  await site.getByRole("button", { name: "Remove password" }).click();
  await expect(site.getByRole("heading", { name: "Published", exact: true })).toBeVisible();
  await expect(site).toContainText("Anyone with the address can read it.");
  await site.getByLabel("Update site password").fill("second-password");
  await site.getByRole("button", { name: "Set password" }).click();
  await expect(site.getByRole("heading", { name: "Published · password required" })).toBeVisible();
  expect(await calls("password")).toEqual([["prism", null], ["prism", "second-password"]]);

  // Unpublish: confirm first (and it says what stops working); Cancel changes nothing.
  await site.getByRole("button", { name: "Unpublish", exact: true }).click();
  const off = site.getByRole("group", { name: "Confirm unpublishing" });
  await expect(off).toContainText("The address above stops working for everyone at once. The pages themselves are not changed");
  await off.getByRole("button", { name: "Cancel" }).click();
  expect(await calls("unpublish")).toEqual([]);
  await expect(site).toHaveAttribute("data-published", "true");
  await site.getByRole("button", { name: "Unpublish", exact: true }).click();
  await off.getByRole("button", { name: "Unpublish site" }).click();
  expect(await calls("unpublish")).toEqual([["prism"]]);
  await expect(site).toHaveAttribute("data-published", "false");
  await expect(site.getByRole("button", { name: "Publish collection", exact: true })).toBeVisible(); // back at the start: no dead end

  // The studio is the same site: the hand-off opens it and closes the dialog.
  await dialog.getByRole("button", { name: "Review and publish in the Publishing studio" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => { const s = (window as any).prismSharingUI.getState(); return s.openTabs.find((t: any) => t.id === s.activeTabId)?.noteId; })).toBe("network");
  // Phone: the whole flow fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "?tree");
  await page.getByRole("tab", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish collection", exact: true }).click();
  await expect(page.getByRole("group", { name: "Confirm publishing" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await page.getByRole("button", { name: "Publish site", exact: true }).click();
  await expect(
    page.getByText("Published · password required", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unpublish", exact: true }).click();
  await page.getByRole("button", { name: "Unpublish site", exact: true }).click();
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
