import { test, expect, type Page } from "@playwright/test";
const prefix = "prism:workspace-session:v1:";
const path = "/e2e-fixtures/workspace.html?session";
async function open(page: Page, id: string) {
  await page.evaluate(id => (window as any).prismFixtureUI.getState().openTab(id, id, "document"), id);
}
async function ids(page: Page) {
  return page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs.map((t: any) => t.noteId));
}
async function seed(page: Page, vault = "primary", active = "weekly-review") {
  await page.addInitScript(({ prefix, vault, active }) => {
    const scope = JSON.stringify([location.origin + "/api", "default", vault, "owner@example.test"]);
    localStorage.setItem(prefix + encodeURIComponent(scope), JSON.stringify({ version: 1, ids: ["field-notes", "weekly-review"], active, panel: "agent", panelOpen: true }));
  }, { prefix, vault, active });
}

test("reload restores ordered tabs, active document and agent panel without storing titles or text", async ({ page }) => {
  await page.goto(path);
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  await open(page, "field-notes"); await open(page, "weekly-review");
  await page.evaluate(() => {
    const ui = (window as any).prismFixtureUI;
    ui.getState().reorderTabs("tab-weekly-review", "tab-field-notes");
    ui.getState().setActiveTab("tab-field-notes");
    ui.setState({ contextPanelOpen: true, contextPanelTab: "agent" });
  });
  const stored = await page.evaluate(prefix => Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)), prefix);
  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0][1])).toEqual({ version: 1, ids: ["weekly-review", "field-notes"], active: "field-notes", panel: "agent", panelOpen: true });
  await page.reload();
  await expect.poll(() => ids(page)).toEqual(["weekly-review", "field-notes"]);
  await expect(page.getByRole("heading", { name: "Field notes", exact: true }).first()).toBeVisible();
  await expect(page.getByText("Agent unavailable")).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
});

test("denied tab never renders a saved title or body and can be dismissed", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&deny=weekly-review");
  await expect(page.getByRole("button", { name: "Retry restore" })).toBeVisible();
  expect(await ids(page)).toEqual(["field-notes"]);
  await expect(page.getByText("What moved forward this week?")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry restore" }).click();
  await expect(page.getByRole("button", { name: "Retry restore" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  expect(await page.evaluate(prefix => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith(prefix))![1]).ids, prefix)).toEqual(["field-notes"]);
});

test("navigation wins over delayed restoration", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&hold=weekly-review");
  await expect(page.getByText("Reopening your workspace…")).toBeVisible();
  await open(page, "workspace");
  await page.evaluate(() => (window as any).prismFixtureReleaseRead("weekly-review"));
  await expect(page.getByText("Reopening your workspace…")).toHaveCount(0);
  expect(await ids(page)).toEqual(["workspace"]);
});

test("vault switch returns to the correct saved workspace", async ({ page }) => {
  await page.goto(path);
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  await open(page, "field-notes");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await expect.poll(() => ids(page)).toEqual([]);
  await open(page, "weekly-review");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("primary"));
  await expect.poll(() => ids(page)).toEqual(["field-notes"]);
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await expect.poll(() => ids(page)).toEqual(["weekly-review"]);
});

test("late reads from the previous vault cannot reopen its documents", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&hold=weekly-review");
  await expect(page.getByText("Reopening your workspace…")).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await open(page, "workspace");
  await page.evaluate(() => (window as any).prismFixtureReleaseRead("weekly-review"));
  await expect.poll(() => ids(page)).toEqual(["workspace"]);
  await expect(page.getByText("Reopening your workspace…")).toHaveCount(0);
});

test("phone reload restores the document without covering it with an agent drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Weekly review", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Document panel" })).toHaveCount(0);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Document panel" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

// A restore lands whenever the server answers. On a slow connection the reader has already
// opened the Browse drawer by then; the restored tab must not shut it under their finger
// (only a page a person opens dismisses the drawer).
test("phone: a workspace restored late leaves the drawer the reader opened meanwhile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.goto(path + "&hold=weekly-review");
  await expect(page.getByText("Reopening your workspace…")).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(drawer).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureReleaseRead("weekly-review"));
  await expect.poll(() => ids(page)).toEqual(["field-notes", "weekly-review"]);
  await expect(page.getByText("Reopening your workspace…")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  // A page the reader opens from the drawer still dismisses it.
  await drawer.getByRole("tree", { name: "Pages" }).getByRole("treeitem", { name: "Field notes", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Field notes", exact: true }).first()).toBeVisible();
});

test("explicit deep link takes precedence over saved tabs", async ({ page }) => {
  await seed(page);
  await page.goto("/e2e-fixtures/workspace.html");
  await expect(page.getByRole("heading", { name: /A living workspace/ })).toBeVisible();
  expect(await ids(page)).toEqual(["workspace"]);
});

test("blocked workspace storage does not prevent document navigation", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("prism:workspace-session:")) throw new DOMException("Blocked", "SecurityError"); return set.call(this, key, value); };
    Storage.prototype.getItem = function(key) { if (key.startsWith("prism:workspace-session:")) throw new DOMException("Blocked", "SecurityError"); return get.call(this, key); };
  });
  await page.goto(path);
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  await open(page, "field-notes");
  await expect(page.getByRole("heading", { name: "Field notes", exact: true }).first()).toBeVisible();
});


test("restoration cannot use a stale offline body as evidence of current access", async ({ page }) => {
  await page.goto(path);
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  await open(page, "field-notes");
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
  // The normal document read populated IndexedDB. A fresh restoration must fail
  // closed on a network error instead of silently using that earlier body.
  await page.goto(path + "&unavailable=field-notes");
  await expect(page.getByRole("button", { name: "Retry restore" })).toBeVisible();
  expect(await ids(page)).toEqual([]);
  await expect(page.getByText("Useful observations from our last conversation.")).toHaveCount(0);
  await page.goto(path);
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
});

test("malformed or oversized navigation records are ignored", async ({ page }) => {
  await page.addInitScript(prefix => {
    const scope = JSON.stringify([location.origin + "/api", "default", "primary", "owner@example.test"]);
    localStorage.setItem(prefix + encodeURIComponent(scope), JSON.stringify({ version: 1, ids: Array(500).fill("field-notes"), active: "field-notes" }));
  }, prefix);
  await page.goto(path);
  await expect(page.getByText("Open a document", { exact: true })).toBeVisible();
  expect(await ids(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).prismFixtureReads)).toEqual([]);
});
