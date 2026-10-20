import { test, expect, type Page } from "@playwright/test";

/**
 * Slice M · NP-DB-20 "Renaming the row updates the view" — for a row that carries a stored
 * title (`metadata.title`: every row made in a view before this change, hand-made and imported
 * pages). The page's NAME is its path; a rename makes the stored title say what was typed —
 * removed when the file name says it, stored when the file name cannot hold it — so the table,
 * the board card and the calendar chip all show the new name. A new row stores no copy of its
 * file name.
 * Fixture: databases.html (rows t1…t6 carry `metadata.title`).
 */
const note = (page: Page, id: string) => page.evaluate((i) => (window as any).dbFixture.notes().find((n: any) => n.id === i), id);
const created = (page: Page) => page.evaluate(() => (window as any).dbFixture.creates.at(-1));

async function renameInPeek(page: Page, from: string, to: string) {
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("button", { name: from, exact: true }).click();
  const peek = page.getByRole("dialog", { name: new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(side peek\\)`) });
  await peek.getByRole("button", { name: `Rename ${from}`, exact: true }).click();
  const title = peek.getByRole("textbox", { name: "Document title" });
  await title.fill(to);
  await title.press("Enter");
  return table;
}

test("renaming a row with a stored title from the peek: the table, the board card and the calendar chip show the new name", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("table", { name: "All tasks" })).toBeVisible();
  expect((await note(page, "t5")).metadata.title).toBe("Update pricing page");
  const table = await renameInPeek(page, "Update pricing page", "Publish the new pricing");
  await expect.poll(async () => (await note(page, "t5")).path).toBe("Projects/Launch plan/Publish the new pricing");
  // One source of truth: the stored copy of the old name is gone, the properties are untouched.
  await expect.poll(async () => (await note(page, "t5")).metadata.title).toBeUndefined();
  expect((await note(page, "t5")).metadata).toMatchObject({ status: "done", priority: "low" });
  await expect(table.getByRole("button", { name: "Publish the new pricing", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Update pricing page", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Board card.
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.locator(".db-card-title", { hasText: "Publish the new pricing" })).toBeVisible();
  await expect(page.locator(".db-card-title", { hasText: "Update pricing page" })).toHaveCount(0);
  // Calendar chip (the row is due yesterday; the month shown holds it unless today is the 1st).
  await page.getByRole("tab", { name: "Calendar" }).click();
  const calendar = page.getByRole("grid", { name: "Calendar calendar" });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByText("Update pricing page")).toHaveCount(0);
  if (new Date().getDate() !== 1) await expect(calendar.getByText("Publish the new pricing").first()).toBeVisible();
});

test("renaming the row from its own tab: the view shows the new name when it is opened again", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?open=t3");
  await page.getByRole("button", { name: "Rename Refine onboarding copy", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("Rewrite onboarding copy");
  await title.press("Enter");
  await expect.poll(async () => (await note(page, "t3")).path).toBe("Projects/Launch plan/Rewrite onboarding copy");
  await expect.poll(async () => (await note(page, "t3")).metadata.title).toBeUndefined();
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: "Rewrite onboarding copy", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Refine onboarding copy", exact: true })).toHaveCount(0);
});

test("a new row stores no copy of its file name, shows its whole name, and follows a rename", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "New page title" }).fill("Plan v1.5");
  await page.keyboard.press("Enter");
  // The name is the path — "v1.5" is part of it, not a file extension.
  await expect(table.getByRole("button", { name: "Plan v1.5", exact: true })).toBeVisible();
  const row = await created(page);
  expect(row.path).toBe("Projects/Launch plan/Plan v1.5");
  expect(row.metadata.title).toBeUndefined();
  await renameInPeek(page, "Plan v1.5", "Plan v2");
  await expect(table.getByRole("button", { name: "Plan v2", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Plan v1.5", exact: true })).toHaveCount(0);
});

test("a title the path cannot hold is still stored — and a rename replaces it too", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "New page title" }).fill("Fix: a/b");
  await page.keyboard.press("Enter");
  await expect(table.getByRole("button", { name: "Fix: a/b", exact: true })).toBeVisible();
  const row = await created(page);
  expect(row.metadata.title).toBe("Fix: a/b");
  expect(row.path).not.toContain("a/b");
});

/**
 * Titles a file name cannot hold. Nothing typed is lost: the view shows exactly what was typed
 * (trimmed), and the stored title exists exactly when the file name differs from it.
 */
for (const [typed, shown] of [
  ["Plan: Q4/2026", "Plan: Q4/2026"], // a slash (and a colon)
  ["Budget: draft", "Budget: draft"], // a colon alone
  ["Version 2.", "Version 2."], // a trailing dot
  ["  Padded title  ", "Padded title"], // leading / trailing spaces are not part of a title
] as const) {
  test(`renaming to a title the path may not hold keeps what was typed — ${JSON.stringify(typed)}`, async ({ page }) => {
    await page.goto("/e2e-fixtures/databases.html");
    await expect(page.getByRole("table", { name: "All tasks" })).toBeVisible();
    const table = await renameInPeek(page, "Update pricing page", typed);
    await expect.poll(async () => (await note(page, "t5")).path).not.toBe("Projects/Launch plan/Update pricing page");
    await expect(table.getByRole("button", { name: shown, exact: true })).toBeVisible();
    await expect(table.getByRole("button", { name: "Update pricing page", exact: true })).toHaveCount(0);
    const after = await note(page, "t5");
    const leaf = String(after.path).split("/").pop();
    // The stored title is there exactly when the file name cannot say the title.
    if (leaf === shown) expect(after.metadata.title).toBeUndefined();
    else expect(after.metadata.title).toBe(shown);
    expect(String(after.path).startsWith("Projects/Launch plan/")).toBe(true);
    expect(leaf).not.toContain("/");
  });
}

test("a title of its own (one the old path could not hold) is replaced by the rename, never left behind", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  // An imported page: the title has a slash, the file name has not.
  await page.evaluate(() => {
    const notes = (window as any).dbFixture.notes();
    const n = notes.find((x: any) => x.id === "t5");
    n.path = "Projects/Launch plan/Plan- Q4-2026";
    n.metadata = { ...n.metadata, title: "Plan: Q4/2026" };
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  });
  await page.reload();
  const table = page.getByRole("table", { name: "All tasks" });
  await expect(table.getByRole("button", { name: "Plan: Q4/2026", exact: true })).toBeVisible();
  // The page header shows the file name; renaming it to another unrepresentable title keeps that title.
  await table.getByRole("button", { name: "Plan: Q4/2026", exact: true }).click();
  const peek = page.getByRole("dialog", { name: /\(side peek\)/ });
  await peek.getByRole("button", { name: /^Rename / }).click();
  const title = peek.getByRole("textbox", { name: "Document title" });
  await title.fill("Roadmap: H1/2027");
  await title.press("Enter");
  await expect(table.getByRole("button", { name: "Roadmap: H1/2027", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Plan: Q4/2026", exact: true })).toHaveCount(0);
  const after = await note(page, "t5");
  expect(after.metadata.title).toBe("Roadmap: H1/2027");
  expect(after.path).toBe("Projects/Launch plan/Roadmap: H1-2027");
});

test("a title write that fails after the page moved says so, keeps the typed title, and Enter finishes it without a second move", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("button", { name: "Update pricing page", exact: true }).click();
  const peek = page.getByRole("dialog", { name: /\(side peek\)/ });
  await peek.getByRole("button", { name: "Rename Update pricing page", exact: true }).click();
  const title = peek.getByRole("textbox", { name: "Document title" });
  await title.fill("Plan: Q4/2026");
  await page.evaluate(() => { (window as any).dbFixture.failNext = true; }); // the next property write is refused (503)
  await title.press("Enter");
  // The page moved; the title did not get written — said, with the typed title still in the field.
  await expect.poll(async () => (await note(page, "t5")).path).toBe("Projects/Launch plan/Plan: Q4-2026");
  await expect(peek.getByRole("alert")).toContainText("Renamed; the title could not be updated");
  await expect(title).toHaveValue("Plan: Q4/2026");
  const moves = () => page.evaluate(() => (window as any).dbFixture.writes.filter((w: any) => typeof w.path === "string").length);
  const before = await moves();
  // Enter again: only the title is written.
  await title.press("Enter");
  await expect.poll(async () => (await note(page, "t5")).metadata.title).toBe("Plan: Q4/2026");
  expect(await moves()).toBe(before);
  await expect(table.getByRole("button", { name: "Plan: Q4/2026", exact: true })).toBeVisible();
});

test("a typed title that differs from the stored one only where the path cannot say it is written without a move", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.evaluate(() => {
    const notes = (window as any).dbFixture.notes();
    const n = notes.find((x: any) => x.id === "t5");
    n.path = "Projects/Launch plan/Plan- Q4-2026";
    n.metadata = { ...n.metadata, title: "Plan: Q4/2026" };
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  });
  await page.reload();
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("button", { name: "Plan: Q4/2026", exact: true }).click();
  const peek = page.getByRole("dialog", { name: /\(side peek\)/ });
  await peek.getByRole("button", { name: /^Rename / }).click();
  const title = peek.getByRole("textbox", { name: "Document title" });
  await title.fill("Plan- Q4/2026"); // the same file name once the slash is replaced
  await title.press("Enter");
  await expect.poll(async () => (await note(page, "t5")).metadata.title).toBe("Plan- Q4/2026");
  expect((await note(page, "t5")).path).toBe("Projects/Launch plan/Plan- Q4-2026");
  await expect(table.getByRole("button", { name: "Plan- Q4/2026", exact: true })).toBeVisible();
});

test("a blank stored title does not block the rename's title write (compare-and-set on the value as stored)", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  await page.evaluate(() => {
    const notes = (window as any).dbFixture.notes();
    const n = notes.find((x: any) => x.id === "t5");
    n.metadata = { ...n.metadata, title: "   " };
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  });
  await page.reload();
  const table = await renameInPeek(page, "Update pricing page", "Plan: Q4/2026");
  await expect.poll(async () => (await note(page, "t5")).path).toBe("Projects/Launch plan/Plan: Q4-2026");
  await expect.poll(async () => (await note(page, "t5")).metadata.title).toBe("Plan: Q4/2026");
  await expect(table.getByRole("button", { name: "Plan: Q4/2026", exact: true })).toBeVisible();
});
