/**
 * NP-CO-05/06/07/09, NP-SB-09, NP-CO-14 — sharing a page, inherited access, the
 * guest's "Shared with me", and guest isolation against the REAL server.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

const shots = "/private/tmp/claude-501/-Users-benjaminlife-dev-prism/94600911-66b9-4b8d-b802-fc8f8fe9305f/scratchpad/w2-sharing";

async function openShare(page: import("@playwright/test").Page, query = "?page") {
  await page.goto(`/e2e-fixtures/sharing.html${query}`);
  await page.getByRole("button", { name: "Share fixture", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share document" })).toBeVisible();
}
const calls = (page: import("@playwright/test").Page, kind: string) =>
  page.evaluate((k) => (window as any).prismSharingFixture.calls.filter((c: any) => c.kind === k).map((c: any) => c.args), kind);

test("sub-pages inherit and show source", async ({ page }) => {
  await openShare(page);
  const dialog = page.getByRole("dialog", { name: "Share document" });
  // Underline tabs (People · Link access · Publish · Sync).
  await expect(dialog.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tab", { name: "Link access" })).toBeVisible();
  // Owner row, named people with avatars, the scope of each grant.
  const owner = dialog.locator("[data-share-owner]");
  await expect(owner).toContainText("Alex Rivera");
  await expect(owner).toContainText("Owner");
  await expect(dialog.getByText("Morgan Lee", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Includes sub-pages/)).toBeVisible();
  await expect(dialog.getByText(/This page only/)).toBeVisible();
  await expect(dialog.locator(".prism-person-avatar").first()).toBeVisible();
  // Inherited access names its source page.
  const inherited = dialog.locator('[data-inherited-from="prism"]');
  await expect(inherited).toContainText("Jordan Diaz");
  await expect(inherited).toContainText("Inherited from Prism");
  // Inviting with "Include sub-pages" (default) makes a page share; unchecked, this page only.
  await expect(dialog.getByText("Give people access to this page and its sub-pages.")).toBeVisible();
  await dialog.getByLabel("Invite people", { exact: true }).fill("new@example.test");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog.getByText("new@example.test", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Include sub-pages" }).uncheck();
  await expect(dialog.getByText("Give people access to this page only.")).toBeVisible();
  await dialog.getByLabel("Invite people", { exact: true }).fill("solo@example.test");
  await dialog.getByLabel("Collaborator permission").selectOption("full");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog.getByText("solo@example.test", { exact: true })).toBeVisible();
  const set = await calls(page, "setPerson");
  expect(set[0]).toEqual(["private", "new@example.test", "view", { scope: "page" }]);
  expect(set[1][3].scope).toBe("note");
  expect(set[1][3].caps).toEqual(expect.arrayContaining(["share", "delete", "organize", "edit"]));
  await expect(dialog.getByLabel("Permission for solo@example.test", { exact: true })).toHaveValue("full");
  // Restrict an inherited person on this page: it becomes this page's own page grant.
  await dialog.getByLabel("Permission for jordan.diaz@prism.test on this page").selectOption("comment");
  await expect(dialog.locator('[data-inherited-from="prism"]')).toHaveCount(0);
  await expect(dialog.getByLabel("Permission for jordan.diaz@prism.test", { exact: true })).toHaveValue("comment");
  expect((await calls(page, "setPerson"))[2]).toEqual(["private", "jordan.diaz@prism.test", "comment", { scope: "page" }]);
  await page.screenshot({ path: `${shots}/share-dialog-desktop-light.png` });
  // Moving a page out of a shared page warns who loses access.
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=move");
  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Morgan Lee, Sam Chen will lose access");
  await expect(warning).toContainText("no longer applies after the move");
  expect(await page.evaluate(() => (window as any).notionSharing.previews)).toEqual([["handbook", "Archive"]]);
});

test("share dialog is a phone sheet with underline tabs and no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openShare(page);
  const dialog = page.getByRole("dialog", { name: "Share document" });
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.getByRole("tab", { name: "People" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Link access" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText(/^Anyone with a link below|^Restricted/)).toBeVisible();
  await page.screenshot({ path: `${shots}/share-dialog-phone-light.png` });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.getByRole("button", { name: "Share fixture", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `${shots}/share-dialog-phone-dark.png` });
});

test("guest sidebar shows only shared pages", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=shared&guest");
  const section = page.getByRole("region", { name: "Shared with me" });
  await expect(section.getByRole("button", { name: /Launch plan/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /Field notes/ })).toBeVisible();
  await expect(section.getByText("Everything tagged #field-guide")).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(2);
  await section.getByRole("button", { name: /Launch plan/ }).click();
  await expect(section.getByRole("button", { name: /Launch plan/ })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => (window as any).notionSharing.opened)).toEqual(["plan"]);
  await page.screenshot({ path: `${shots}/shared-with-me-guest.png` });
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=shared&guest&empty");
  await expect(page.getByText("Nothing has been shared with you yet.")).toBeVisible();
  // A member with nothing shared sees no section at all.
  await page.goto("/e2e-fixtures/notion-sharing.html?panel=shared&empty");
  await expect(page.getByRole("region", { name: "Shared with me" })).toHaveCount(0);
});

test.describe("against the real server", () => {
  let server: RealServer;
  test.beforeAll(async ({}, info) => {
    server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
  });
  test.afterAll(async () => server?.stop());

  test("guest sees only shared content everywhere", async ({ page }) => {
    await connect(page, page.context(), server, "gina");
    await page.goto("/e2e-fixtures/harness.html");
    const read = (path: string, init?: RequestInit) =>
      page.evaluate(
        async ([p, i]) => {
          const r = await fetch(p as string, { credentials: "include", ...(i as RequestInit) });
          return { status: r.status, body: await r.json().catch(() => null) };
        },
        [path, init ?? null] as const,
      );
    const ids = (rows: unknown) => (Array.isArray(rows) ? rows.map((r: any) => r.id).sort() : rows);
    // Sidebar / tree / ⌘K list / search / backlinks graph / databases / comments: only the shared page and its sub-page.
    expect((await read("/api/shared-with-me")).body.items.map((i: any) => i.id)).toEqual(["plan"]);
    expect(ids((await read("/api/tree")).body)).toEqual(["notes", "plan"]);
    expect(ids((await read("/api/notes")).body)).toEqual(["notes", "plan"]);
    expect(ids((await read("/api/search?q=plan")).body)).toEqual(["notes"]);
    const graph = (await read("/api/graph/neighborhood?center=plan&depth=2")).body;
    expect(JSON.stringify(graph)).not.toContain("secret");
    expect(JSON.stringify(graph)).not.toContain("Budget");
    const query = await read("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["team"] }) });
    expect(query.status).toBe(200);
    expect(JSON.stringify(query.body)).not.toContain("secret");
    expect(JSON.stringify(query.body)).not.toContain("rich");
    expect((await read("/api/comments")).status).toBe(200);
    // Unshared pages are indistinguishable from missing ones.
    for (const id of ["secret", "rich"]) {
      expect((await read(`/api/notes/${id}`)).status).toBe(403);
      expect((await read(`/api/comments?note=${id}`)).status).toBe(404);
      expect((await read(`/api/notes/${id}/activity`)).status).toBe(404);
    }
    // No workspace structure: tags only for what she can see.
    expect(JSON.stringify((await read("/api/tags")).body)).not.toContain("Private");
  });
});

// ── wave 2A (merged from main) ───────────────────────────────────────────────
/** Request access (NP-CO-13): a member asks for a page they can't open; the owner approves from the Inbox. */
const SHOTS = process.env.INBOX_SHOTS;
const url = (q = "") => `/e2e-fixtures/notion-inbox.html${q}`;
const writes = (page: Page) => page.evaluate(() => (window as any).prismFixtureWrites as Array<Record<string, unknown>>);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

test("request access → owner approves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The member opens a page they cannot view: no title, no content — just a way to ask.
  await page.goto(url("?reset&as=member&open=secret"));
  const main = page.locator("#workspace-document");
  await expect(main.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
  await expect(main).not.toContainText("Confidential");
  await expect(main).not.toContainText("Budget 2027");
  await shot(page, "request-access-1440-light");
  await main.getByRole("button", { name: "Request access" }).click();
  await expect(main.getByRole("status")).toHaveText(/Request sent/);
  expect((await writes(page)).find((w) => w.requestAccess)).toEqual({ requestAccess: { noteId: "secret", level: "view" } });

  // The owner sees the request in the Inbox and approves it with a level.
  await page.goto(url("?as=owner&open=notifications"));
  const row = page.getByTestId("notification-row").filter({ hasText: "Sam Ortiz requested access to Budget 2027" });
  await expect(row).toHaveAttribute("data-unread", "true");
  await shot(page, "access-request-owner-1440-light");
  await row.getByLabel("Access level").selectOption("edit");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByTestId("access-decided")).toHaveText("Approved · can edit");
  expect((await writes(page)).find((w) => w.decide)).toMatchObject({ decide: "req-1", decision: "approve", level: "edit" });

  // The member now opens the page and is told the request was approved.
  await page.goto(url("?as=member&open=secret"));
  await expect(page.locator("#workspace-document")).toContainText("Confidential numbers.");
  await page.locator(".workspace-navigation").first().getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByTestId("notification-row").filter({ hasText: "Your access request was approved: Budget 2027" })).toBeVisible();
});
