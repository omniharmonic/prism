import { test, expect } from "@playwright/test";
const path = "/e2e-fixtures/workspace.html?session&events";
test("a failed first read explains the connection problem and retries the same tab", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => {
    (window as any).prismFixtureControls.noteStatus["field-notes"] = 503;
    (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document");
  });
  await expect(page.getByRole("heading", { name: "Couldn’t open this document" })).toBeVisible();
  await page.evaluate(() => delete (window as any).prismFixtureControls.noteStatus["field-notes"]);
  await page.getByRole("button", { name: "Retry document" }).click();
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
});

test("a confirmed access revocation hides cached text and details, then retry requires fresh access", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismFixtureControls.noteStatus["field-notes"] = 403;
    (window as any).prismFixtureInvalidate("field-notes");
  });
  await expect(page.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
  await expect(page.locator(".tiptap")).toHaveCount(0);
  await expect(page.getByText("Useful observations from our last conversation.")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs[0].title)).toBe("Unavailable document");
  await page.getByRole("button", { name: "Retry document" }).click();
  await expect(page.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
  await page.evaluate(() => delete (window as any).prismFixtureControls.noteStatus["field-notes"]);
  await page.getByRole("button", { name: "Retry document" }).click();
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismFixtureUI.getState().openTabs[0].title)).toBe("Field notes");
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
});

test("temporary background read failures retain the same editor and unsaved draft", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" DRAFT_DURING_RECHECK");
  await page.evaluate(() => {
    (window as any).prismEditorBeforeFailure = document.querySelector(".tiptap");
    (window as any).prismFixtureControls.noteStatus["field-notes"] = 503;
    (window as any).prismFixtureInvalidate("field-notes");
  });
  await expect.poll(() => page.evaluate(() => (window as any).prismFixtureReads.filter((id: string) => id === "field-notes").length)).toBeGreaterThan(3);
  await expect(editor).toContainText("DRAFT_DURING_RECHECK");
  expect(await page.evaluate(() => (window as any).prismEditorBeforeFailure === document.querySelector(".tiptap"))).toBe(true);
  await expect(page.getByRole("heading", { name: "Couldn’t open this document" })).toHaveCount(0);
});

async function drafts(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("prism-web", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise<any[]>((resolve, reject) => { const request = db.transaction("outbox").objectStore("outbox").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return rows;
  });
}

test("a pending autosave stays in its original vault when the editor unmounts during a switch", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" ORIGINAL_VAULT_DRAFT");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await expect.poll(async () => (await drafts(page)).length).toBe(1);
  const [draft] = await drafts(page);
  expect(draft.state).toBe("blocked");
  expect(draft.scope.vault).toBe("primary");
  expect(draft.scope.actor).toBe("user:owner@example.test");
  expect(JSON.parse(draft.body).content).toContain("ORIGINAL_VAULT_DRAFT");
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  await page.clock.resume();
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("primary"));
  await page.evaluate(async () => { const modulePath = "/src/offline/outbox.ts"; const module = await import(/* @vite-ignore */ modulePath); await module.flush(); });
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  expect((await drafts(page))[0].state).toBe("blocked");
  await expect(page.getByText("Useful observations from our last conversation.", { exact: true })).toBeVisible();
});

test("account-switch cleanup cannot submit the previous account's pending draft", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" ORIGINAL_ACCOUNT_DRAFT");
  await page.evaluate(() => (window as any).prismFixtureSwitchActor("second@example.test"));
  await expect.poll(async () => (await drafts(page)).length).toBe(1);
  const [draft] = await drafts(page);
  expect(draft.scope.actor).toBe("user:owner@example.test");
  expect(draft.state).toBe("blocked");
  expect(JSON.parse(draft.body).content).toContain("ORIGINAL_ACCOUNT_DRAFT");
  const status = await page.evaluate(async (scope) => {
    const modulePath = "/src/parachute/rest.ts";
    const rest = await import(/* @vite-ignore */ modulePath);
    try {
      await rest.updateNote("field-notes", { content: "MUST_NOT_SEND" }, { expectedScope: JSON.stringify([scope.api, scope.workspace, scope.vault, "owner@example.test"]) });
      return 200;
    } catch (error) { return (error as { status?: number }).status; }
  }, draft.scope);
  expect(status).toBe(403);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  await page.clock.resume();
});

test("a denied save retains a recoverable draft without reporting a remote save", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureControls.rejectWrite = true);
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" DENIED_SAVE_DRAFT");
  await editor.press("ControlOrMeta+s");
  await expect(page.getByText("Your draft is saved on this device for review in the original workspace. It has not been sent.")).toBeVisible();
  const [draft] = await drafts(page);
  expect(draft.state).toBe("blocked");
  expect(JSON.parse(draft.body).content).toContain("DENIED_SAVE_DRAFT");
  await page.evaluate(async (draft) => {
    const modulePath = "/src/parachute/rest.ts"; const module = await import(/* @vite-ignore */ modulePath);
    const audience = JSON.stringify([draft.scope.api, draft.scope.workspace, draft.scope.vault, "owner@example.test"]);
    await Promise.all([1, 2].map(() => module.preserveDraft("field-notes", JSON.parse(draft.body).content, audience)));
  }, draft);
  expect(await drafts(page)).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Useful observations from our last conversation.", { exact: true })).toBeVisible();
  await expect(page.locator(".tiptap")).toContainText("DENIED_SAVE_DRAFT");
  expect(await page.evaluate(async () => (await (await fetch("/api/notes/field-notes")).json()).content.includes("DENIED_SAVE_DRAFT"))).toBe(false);
  expect(await page.evaluate(() => (window as any).prismFixtureWrites)).toEqual([]);
  expect((await drafts(page))[0].state).toBe("blocked");
});


test("a local draft-storage failure keeps the editor's text and never claims it was preserved", async ({ page }) => {
  await page.goto(path);
  await page.evaluate(() => (window as any).prismFixtureUI.getState().openTab("field-notes", "Field notes", "document"));
  const editor = page.locator(".tiptap[contenteditable=true]");
  await expect(editor).toBeVisible();
  await page.evaluate(() => {
    (window as any).prismFixtureControls.rejectWrite = true;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args: Parameters<typeof original>) {
      if (this.name === "prism-web" && args[1] === "readwrite") throw new DOMException("Fixture quota", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await editor.pressSequentially("KEEP_UNSAVED_DRAFT ");
  await editor.press("ControlOrMeta+s");
  await expect(page.getByText("Your draft could not be saved on this device. Keep this page open and copy your changes before leaving.")).toBeVisible();
  await expect(editor).toContainText("KEEP_UNSAVED_DRAFT");
  expect(await drafts(page)).toEqual([]);
});
