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


test("session permission selector supports all three modes and restores the saved choice", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?permissions");
  const selector = page.getByRole("combobox", { name: "Agent permissions" });
  await expect(selector).toHaveValue("read-only");
  await selector.selectOption("suggest");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Propose a change");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-conversation-title")).toHaveText("Document conversation");
  await expect(selector).toHaveValue("suggest");
  await selector.selectOption("read-write");
  await expect(selector).toHaveValue("read-write");
  await page.reload();
  await expect(selector).toHaveValue("read-write");
  await selector.selectOption("read-only");
  await expect(selector).toHaveValue("read-only");
});

test("pending downgrade stays visible and prevents sending until confirmed", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?permissions");
  const selector = page.getByRole("combobox", { name: "Agent permissions" });
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await selector.selectOption("read-write");
  await input.fill("Work on this document");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("agent-conversation-title")).toHaveText("Document conversation");
  await input.fill("Next request");
  await page.evaluate(() => { (window as any).prismAgentFixture.pendingMode = true; });
  await selector.selectOption("read-only");
  await expect(page.getByRole("status")).toContainText("Stopping previous work");
  await expect(selector).toHaveValue("read-write");
  await expect(selector).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(selector).toHaveValue("read-only");
  await expect(selector).toBeEnabled();
  await expect(input).toHaveValue("Next request");
});


test("mobile agent controls fit the screen and Enter keeps a multiline draft", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/agent.html?permissions");
  await expect(page.getByRole("combobox", { name: "Agent permissions" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("First thought");
  await input.press("Enter");
  await input.pressSequentially("More context");
  await expect(input).toHaveValue("First thought\nMore context");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.attempts)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("agent-permissions-mobile.png") });
});


test("finished streamed turn refreshes the open conversation's spending summary", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?budget");
  await expect(page.getByRole("status", { name: "Session spend" })).toHaveText("0");
  await page.getByRole("button", { name: "Send test turn" }).click();
  await page.evaluate(() => (window as any).prismAgentFixture.completeTurn());
  await expect(page.getByRole("status", { name: "Session spend" })).toHaveText("0.06");
});

test("working document and draft stay pinned while reading references, expanding and reloading", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?context");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  const working = page.getByTestId("agent-working-document");
  await expect(working).toContainText("Draft brief");
  await input.fill("Revise the brief using this reference");
  await page.getByRole("button", { name: "Open reference", exact: true }).click();
  await expect(working).toContainText("Draft brief");
  await expect(input).toHaveValue("Revise the brief using this reference");
  await page.getByRole("button", { name: "Open in Agent tab" }).click();
  await expect(working).toContainText("Draft brief");
  await expect(input).toHaveValue("Revise the brief using this reference");
  await page.reload();
  await expect(working).toContainText("Draft brief");
  await page.getByRole("button", { name: "Open reference", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(working).toContainText("Reference note");
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Morgan", exact: true }).click();
  await expect(working).toContainText("Reference note");
  await page.getByRole("button", { name: "Alex", exact: true }).click();
  await expect(working).toContainText("Reference note");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.attempts)).toBe(0);
});

test("conversation identifies its authors and archive is a separate keyboard action", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/agent.html?history&permissions");
  await expect(page.getByTestId("agent-assistant-message")).toContainText("A shared place to think");
  await expect(page.getByText("You", { exact: true })).toBeVisible();
  await expect(page.getByText("Prism agent", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-working-document")).toContainText("Draft brief");
  const second = page.getByTestId("agent-session-row").filter({ hasText: "Explore the source material" });
  await second.focus();
  await page.keyboard.press("Tab");
  const archive = page.getByRole("button", { name: "Archive session", exact: true }).nth(1);
  await expect(archive).toBeFocused();
  await expect(archive).toHaveCSS("opacity", "1");
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Enter");
  await expect(second).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismAgentStore.getState().activeSessionId)).toBe("fixture-session");
  await page.screenshot({ path: testInfo.outputPath("document-conversation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("document-conversation-mobile.png") });
});

test("agent Markdown renders lists and tables while keeping HTML, URLs and remote images inert", async ({ page }) => {
  const external: string[] = [];
  await page.route("https://untrusted.example.test/**", (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/e2e-fixtures/agent.html?markdown");
  const input = page.getByRole("textbox", { name: "Fixture Markdown" });
  const reply = page.getByRole("region", { name: "Rendered reply" });
  await input.fill('## Review\n\n- First **point**\n- Second point\n\n1. Read\n2. Discuss\n\n| Mode | Access |\n| --- | --- |\n| Read | View |\n\n> A quoted passage\n\n[Reference](https://example.test/source)\n\n[Unsafe](javascript:alert(1))\n\n![Tracking image](https://untrusted.example.test/pixel.png)\n\n<img src="https://untrusted.example.test/raw.png" onerror="window.prismUnexpectedScript = true">\n\n<script>window.prismUnexpectedScript = true</script>');
  await expect(reply.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(reply.getByRole("listitem")).toHaveCount(4);
  await expect(reply.locator("ul")).toHaveCSS("list-style-type", "disc");
  await expect(reply.getByRole("cell", { name: "View", exact: true })).toBeVisible();
  await expect(reply.getByRole("link", { name: "Reference" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(reply.getByRole("link", { name: "Unsafe" })).toHaveCount(0);
  await expect(reply.locator("img, script, iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismUnexpectedScript)).toBeUndefined();
  expect(external).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('```js\nconst long = "' + 'x'.repeat(300));
  await expect(reply.locator("pre code")).toContainText("const long");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await input.fill('```js\nconst complete = true;\n```\n\nDone.');
  await expect(reply.locator("pre code")).toContainText("const complete = true;");
  await expect(reply.locator("p")).toHaveText("Done.");
});
