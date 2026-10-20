import { test, expect } from "@playwright/test";
for (const width of [1440, 390]) test(`context picker distinguishes included notes and saved source text at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/e2e-fixtures/agent.html?context&attachments");
  await page.getByRole("textbox", { name: "Message the agent" }).fill("Keep this thought while I choose sources.");
  await page.getByRole("button", { name: "Attach notes", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Attach vault notes" });
  await picker.getByRole("textbox", { name: "Search notes to attach" }).fill("reference");
  await picker.getByRole("button", { name: "Reference note", exact: true }).click();
  await expect(picker.getByRole("region", { name: "Included notes" })).toContainText("Reference note");
  await picker.getByRole("button", { name: "Remove included note 1" }).click();
  await expect(picker.getByRole("button", { name: "Reference note", exact: true })).toBeEnabled();
  await picker.getByRole("button", { name: "Reference note", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("light", theme === "light"), theme);
    await page.screenshot({ path: test.info().outputPath(`context-picker-${width}-${theme}.png`), animations: "disabled" });
  }
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-context-attachments").getByRole("button", { name: "Reference note", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Source preview" });
  await expect(preview).toContainText("Saved text preview · Updated");
  await expect(preview).toContainText("Fixture");
  await page.screenshot({ path: test.info().outputPath(`source-preview-${width}-dark.png`), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toHaveValue("Keep this thought while I choose sources.");
  await expect(page.getByTestId("agent-working-document")).toContainText("Draft brief");
});
