import { test, expect, type Page } from "@playwright/test";

async function targets(page: Page) {
  const heading = page.locator(".prism-agent-heading");
  const row = heading.locator(".prism-agent-heading-top");
  const fresh = row.getByRole("button", { name: "New", exact: true });
  await expect(fresh).toBeVisible();
  for (const control of [fresh, row.getByRole("button", { name: "Open in Agent tab" })]) {
    // Crossing a breakpoint re-lays the companion out (rail ↔ overlay ↔ phone sheet) a frame
    // after the resize: measure the control once it is on screen in the NEW layout, never mid-switch.
    // Control-size tokens (tokens.css): a narrow window (< 768 px) gets the 44 px touch target,
    // a desktop width the 28–36 px control size.
    const narrow = (page.viewportSize()?.width ?? 0) < 768;
    await expect.poll(async () => { const b = await control.boundingBox(); return b ? Math.min(b.height, b.width) : 0; }).toBeGreaterThanOrEqual(narrow ? 44 : 28);
    if (!narrow) expect((await control.boundingBox())!.height).toBeLessThanOrEqual(36);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const active of [false, true]) {
  test(`actual Shell ${active ? "active conversation" : "new draft"} retains document and input through compact layouts`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/e2e-fixtures/workspace.html?agent&navigation");
    const editor = page.locator(".tiptap[contenteditable=true]");
    await expect(editor).toBeVisible();
    await page.evaluate(() => { (window as any).densityEditor = document.querySelector(".tiptap"); });
    const prompt = page.getByRole("textbox", { name: "Message the agent" });
    if (active) {
      await prompt.fill("Help clarify the next steps in this page.");
      await page.getByTestId("agent-send").click();
      await expect(page.getByText("Thanks, Morgan. Tuesday afternoon works well. I’ll send the agenda beforehand.", { exact: true })).toBeVisible();
    }
    await prompt.fill("Keep this unsent thought while I review the page.");
    for (const width of [1440, 390, 720, 320, 1440]) {
      await page.setViewportSize({ width, height: width === 720 ? 500 : 844 });
      if (width === 390) {
        // Shell intentionally closes the companion on the desktop→phone edge.
        await expect.poll(() => page.evaluate(() => (window as any).prismFixtureUI.getState().contextPanelOpen)).toBe(false);
        await page.getByRole("button", { name: "Agent", exact: true }).click();
      }
      await expect(prompt).toHaveValue("Keep this unsent thought while I review the page.");
      await expect(page.getByTestId("agent-working-document")).toContainText("A living workspace");
      await targets(page);
      expect(await page.evaluate(() => (window as any).densityEditor === document.querySelector(".tiptap"))).toBe(true);
      if (!active) await expect(page.getByRole("combobox", { name: "Agent permissions" })).toBeVisible();
      else await expect(page.getByTestId("agent-conversation-title")).toHaveText("Help clarify the next steps in this page.");
      if (width === 720) {
        expect((await page.locator(".prism-agent-heading").boundingBox())!.height).toBeLessThan(150);
        expect((await page.getByTestId("agent-messages").boundingBox())!.height).toBeGreaterThan(active ? 210 : 190);
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(t => document.documentElement.classList.toggle("light", t === "light"), theme);
        await page.screenshot({ path: info.outputPath(`companion-${active ? "active" : "draft"}-${width}-${theme}.png`), animations: "disabled" });
      }
    }
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("fixture-agent-reply:")).length)).toBe(active ? 1 : 0);
  });
}

test("compact long title retains permission controls and 44px actions at 320px", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.goto("/e2e-fixtures/agent.html?permissions&context");
  const longTitle = "Shared understanding across research, conversations, and the questions we have yet to ask";
  await page.evaluate(title => (window as any).prismAgentStore.getState().setDraft({ noteId: "document-a", noteTitle: title }), longTitle);
  const mode = page.getByRole("combobox", { name: "Agent permissions" });
  for (const value of ["read-write", "suggest", "read-only"]) {
    await mode.selectOption(value);
    await expect(mode).toHaveValue(value);
    await expect(mode).toBeInViewport();
  }
  await targets(page);
  await expect(page.getByTestId("agent-conversation-title")).toContainText(longTitle);
  await page.screenshot({ path: info.outputPath("companion-long-title-320.png"), animations: "disabled" });
});

test("moved New control retains explicit binding and existing session draft", async ({ page }) => {
  await page.goto("/e2e-fixtures/agent.html?permissions&context");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await expect(page.getByRole("combobox", { name: "Agent permissions" })).toBeVisible();
  await input.fill("Start a conversation about this page.");
  await page.getByTestId("agent-send").click();
  await expect.poll(() => page.evaluate(() => (window as any).prismAgentStore.getState().activeSessionId)).toBe("fixture-session");
  await page.evaluate(() => (window as any).prismAgentFixture.completeTurn());
  await input.fill("Keep this in the existing conversation.");
  await page.getByRole("button", { name: "Open reference", exact: true }).click();
  await expect(page.getByTestId("agent-working-document")).toContainText("Draft brief");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByTestId("agent-working-document")).toContainText("Reference note");
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => (window as any).prismAgentStore.getState().activeSessionId)).toBeNull();
  await page.evaluate(() => (window as any).prismAgentStore.getState().setActiveSession("fixture-session"));
  await expect(input).toHaveValue("Keep this in the existing conversation.");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.turnAttempts)).toBe(1);
});
