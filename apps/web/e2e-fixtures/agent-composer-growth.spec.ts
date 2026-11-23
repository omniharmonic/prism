import { test, expect, type Locator } from "@playwright/test";
const height = (input: Locator) => input.evaluate(el => el.getBoundingClientRect().height);
const long = Array.from({ length: 18 }, (_, index) => `Line ${index + 1}: a careful thought to keep.`).join("\n");

test("agent draft reflows across widths without losing caret, focus or field identity", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixtures/agent.html?permissions&context&visual");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  const text = "Keep this unsent thought while I review the page. I want to see every wrapped line before I send it.";
  await input.fill(text);
  const wide = await height(input);
  await input.evaluate(el => { (window as any).agentField = el; (el as HTMLTextAreaElement).setSelectionRange(18, 26); });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => height(input)).toBeGreaterThan(wide);
    await expect(input).toHaveValue(text);
    await expect(input).toBeFocused();
    expect(await input.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([18, 26]);
    expect(await input.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await input.evaluate(el => (window as any).agentField === el)).toBe(true);
    await page.screenshot({ path: info.outputPath(`agent-wrapped-draft-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => height(input)).toBe(wide);
  expect(await input.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([18, 26]);
  expect(await page.evaluate(() => (window as any).prismAgentFixture.turnAttempts)).toBe(0);
});

test("agent draft caps, follows end typing, retains middle edits and shrinks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/e2e-fixtures/agent.html?permissions&context");
  const input = page.getByRole("textbox", { name: "Message the agent" });
  await expect(input).toBeVisible();
  const initial = await height(input);
  await input.fill(long);
  await expect.poll(() => height(input)).toBe(160);
  await expect(input).toHaveCSS("overflow-y", "auto");
  await input.press("ControlOrMeta+End");
  for (let index = 0; index < 3; index++) { await input.press("Shift+Enter"); await input.pressSequentially(`Another point ${index}`); }
  await expect.poll(() => input.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(25);
  const middle = await input.evaluate(el => {
    const field = el as HTMLTextAreaElement;
    const at = field.value.indexOf("Line 9:");
    field.setSelectionRange(at, at); field.scrollTop = field.scrollHeight / 2 - field.clientHeight / 2;
    return { at, top: field.scrollTop };
  });
  await input.pressSequentially("Edited ");
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(middle.at + 7);
  expect(Math.abs(await input.evaluate(el => el.scrollTop) - middle.top)).toBeLessThan(50);
  await input.fill("A brief thought.");
  await expect.poll(() => height(input)).toBe(initial);
  await expect(input).toHaveCSS("overflow-y", "hidden");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await expect(input).toHaveValue("A brief thought.");
  expect(await page.evaluate(() => (window as any).prismAgentFixture.turnAttempts)).toBe(0);
});
