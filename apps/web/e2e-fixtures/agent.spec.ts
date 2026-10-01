import { test, expect } from "@playwright/test";

test("agent draft survives panel close and reload without sending, isolated by account", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("Keep this document context for Alex");
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(input).toHaveValue("Keep this document context for Alex");
  await page.getByRole("button", { name: "Morgan", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.fill("Morgan's separate context");
  await page.getByRole("button", { name: "Alex", exact: true }).click();
  await expect(input).toHaveValue("Keep this document context for Alex");
  await page.reload();
  await expect(input).toHaveValue("Keep this document context for Alex");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.attempts)).toBe(0);
});

test("failed agent send retains the draft through reload and never sends twice on Enter", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("Retain this until acknowledged");
  await input.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Fixture create rejected");
  await expect(input).toHaveValue("Retain this until acknowledged");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.attempts)).toBe(1);
  await page.reload();
  await expect(input).toHaveValue("Retain this until acknowledged");
});

test("remembered sessions and pending asks never cross audiences or restore legacy IDs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("prism:agent-session", "legacy-unknown-owner"));
  await page.goto("/e2e-fixtures/agent.html");
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  const result = await page.evaluate(() => {
    const store = (window as any).prismAgentStore;
    const initial = store.getState().activeSessionId;
    const first = store.getState().scope;
    store.getState().setActiveSession("alex-session");
    store.getState().setPendingAsk({ prompt: "Alex only" });
    store.getState().bindScope("other-vault-or-account");
    const other = { active: store.getState().activeSessionId, pending: store.getState().pendingAsk };
    store.getState().bindScope(first);
    return { initial, other, restored: store.getState().activeSessionId };
  });
  expect(result).toEqual({ initial: null, other: { active: null, pending: null }, restored: "alex-session" });
});

test("storage failure warns that an agent draft is only in memory", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); }; });
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Keep in memory");
  await expect(page.getByRole("status")).toContainText("only held in this window");
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toHaveValue("Keep in memory");
});


test("host binds resolved actor and vault to every agent request", async ({ page }) => {
  await page.route("**/auth/me", (route) => route.fulfill({ json: { authenticated: true, email: "alex@example.test", vaultId: "resolved-vault", workspace: { id: "resolved-workspace", name: "Fixture" } } }));
  let headers: Record<string, string> = {};
  await page.route("**/api/agent/sessions*", (route) => { headers = route.request().headers(); return route.fulfill({ json: [] }); });
  await page.goto("/e2e-fixtures/agent.html");
  const result = await page.evaluate(async () => {
    const host = (window as any).prismAgentHost;
    await host.fetchMe();
    const scope = host.agentScope();
    await host.httpAgentClient.listSessions();
    host.setActiveVault("another-vault");
    const cleared = (window as any).prismAgentStore.getState().scope;
    let blocked = false;
    try { await host.httpAgentClient.listSessions(); } catch { blocked = true; }
    return { scope: JSON.parse(scope), cleared, blocked };
  });
  expect(result.scope.slice(1)).toEqual(["resolved-workspace", "resolved-vault", "alex@example.test"]);
  expect(result.cleared).toBeNull();
  expect(result.blocked).toBe(true);
  expect(headers["x-prism-workspace"]).toBe("resolved-workspace");
  expect(headers["x-prism-vault"]).toBe("resolved-vault");
  expect(headers["x-prism-write-actor"]).toBe("user:alex@example.test");
});

test("late agent response cannot populate a newly selected audience", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html");
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  const message = await page.evaluate(async () => {
    let scope = "first";
    let resolveBody!: (value: unknown) => void;
    const body = new Promise((resolve) => { resolveBody = resolve; });
    const client = (window as any).prismAgentHost.createHttpAgentClient({
      scope: () => scope,
      fetch: async () => ({ ok: true, json: () => body }),
    });
    const pending = client.listSessions().then(() => "unexpected success", (error: Error) => error.message);
    scope = "second";
    resolveBody([]);
    return pending;
  });
  expect(message).toContain("Workspace changed");
});
