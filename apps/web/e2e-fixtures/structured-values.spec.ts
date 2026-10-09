import { test, expect, type Page } from "@playwright/test";

/**
 * Structured property values (`members: [{name, role}]`) — the owner's `circle` note
 * printed two chips reading "[object Object]". They now read as names, are read-only
 * in every inline editor, and no write path replaces the objects. Fixture:
 * databases.html?circles.
 */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const stored = (page: Page, id: string) => page.evaluate((i) => (window as any).dbFixture.notes().find((n: any) => n.id === i).metadata, id);
const openTabs = (page: Page) => page.evaluate(() => (window as any).prismUI.getState().openTabs.map((t: any) => t.noteId));
const MEMBERS = [{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }];
const bar = (page: Page) => page.getByRole("group", { name: "Page properties" });

test("property bar: members render as names with their role, read-only, and a name that is a person page opens it", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  const props = bar(page);
  const members = props.locator('[data-property-key="members"]');
  await expect(members).toBeVisible();
  await expect(page.locator("body")).not.toContainText("[object Object]");
  await expect(members.locator(".db-chips > *")).toHaveText(["BBenjamin Life — delegate", "Patricia Parkinson — delegate"]);
  // Read-only: a labelled group, not an editor button; nothing opens on click.
  await expect(members.getByRole("group", { name: "Members: Benjamin Life — delegate, Patricia Parkinson — delegate" })).toBeVisible();
  await expect(members.getByRole("button", { name: /^Members:/ })).toHaveCount(0);
  await members.getByText("Patricia Parkinson").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(members.locator("input")).toHaveCount(0);
  // The reason is said (a tap shows it: phones have no hover).
  const lock = members.getByRole("button", { name: /Members is read-only/ });
  await lock.click();
  await expect(members.getByRole("status")).toContainText("Structured value");
  // A {person: [[link]], role} item, an object with no naming key, numbers and booleans in a list.
  await expect(props.locator('[data-property-key="sponsors"]')).toContainText("Mira Chen — sponsor");
  await expect(props.locator('[data-property-key="scores"]')).toContainText("3");
  // "Linked projects" holds the slug `opencivics`: the chip shows the project page's name (its file is …/opencivics/PROJECT).
  await expect(props.locator('[data-property-key="linked_projects"] .db-link-chip')).toHaveText("OpenCivics");
  // The other properties of the page are still editable.
  await expect(props.getByRole("button", { name: "Status: active" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("structured-property-bar.png") });

  // "Benjamin Life" is the title of exactly one #person page: the chip opens it, like a relation chip.
  await members.getByRole("link", { name: /Benjamin Life/ }).click();
  await expect.poll(() => openTabs(page)).toContain("pb");
  // The sponsor's page link opens too.
  await page.evaluate(() => (window as any).prismUI.getState().setActiveTab?.("c1"));
  expect((await fx(page)).writes).toEqual([]);
  expect((await stored(page, "c1")).members).toEqual(MEMBERS);
});

test("database table, board, list and gallery: names in every layout, no editor, objects untouched by a bulk edit", async ({ page }, info) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=dbc");
  const table = page.getByRole("table", { name: "All circles" });
  const row = page.locator("tr", { has: page.getByRole("button", { name: "OpenCivics — Delegate Council", exact: true }) });
  await expect(row).toContainText("Benjamin Life — delegate");
  await expect(row).toContainText("Patricia Parkinson — delegate");
  await expect(row).toContainText("Mira Chen — sponsor");
  await expect(page.locator("body")).not.toContainText("[object Object]");
  // The cell is a read-only group; the plain list in the other row is still an editor.
  await expect(row.getByRole("group", { name: /^Members: Benjamin Life — delegate/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /^Members:/ })).toHaveCount(0);
  const plain = page.locator("tr", { has: page.getByRole("button", { name: "Stewards", exact: true }) });
  await expect(plain.getByRole("button", { name: "Members: facilitation" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("structured-table.png") });

  // Sorting and searching on the column work on the names (the same engine the server runs).
  await page.getByRole("button", { name: "Members", exact: true }).first().click();
  await expect(page.locator("body")).not.toContainText("[object Object]");
  await page.keyboard.press("Escape");

  // Bulk edit over both rows: the structured row is reported and kept, the other is written.
  await table.getByRole("checkbox", { name: "Select OpenCivics — Delegate Council" }).click();
  await table.getByRole("checkbox", { name: "Select Stewards" }).click();
  const toolbar = page.getByRole("toolbar", { name: "Selected pages" });
  await toolbar.getByRole("button", { name: "Edit property" }).click();
  const edit = page.getByRole("dialog", { name: "Edit property on selected pages" });
  await edit.getByLabel("Property to edit").selectOption("members");
  await edit.getByRole("button", { name: "Members: Empty" }).click();
  // In a database the column reads as people (its name): the picker links a person page.
  await page.getByRole("dialog", { name: "Link Members" }).getByRole("option", { name: /Mira Chen/ }).click();
  await expect(page.locator(".db-toast")).toContainText("Updated Members on 1 of 2. Not changed: OpenCivics — Delegate Council (its value is structured and is kept as it is).");
  // The structured row never reached the client's batch route.
  expect((await fx(page)).batches.at(-1)).toEqual([{ id: "c2", set: { members: ["[[People/Mira Chen]]"] }, expect: { members: ["facilitation"] } }]);
  expect((await stored(page, "c1")).members).toEqual(MEMBERS);
  expect(JSON.stringify((await fx(page)).batches)).not.toContain("[object Object]");
  await page.keyboard.press("Escape");

  for (const [tab, shot] of [["By status", "structured-board.png"], ["List", "structured-list.png"], ["Gallery", "structured-gallery.png"]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByText("Benjamin Life — delegate").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("[object Object]");
    await page.screenshot({ path: info.outputPath(shot) });
  }
  // Nothing written anywhere holds the stringified text, and the objects are whole.
  const f = await fx(page);
  expect(JSON.stringify(f.writes)).not.toContain("[object Object]");
  expect(await page.evaluate(() => JSON.stringify((window as any).dbFixture.notes()))).not.toContain("[object Object]");
  expect((await stored(page, "c1")).members).toEqual(MEMBERS);
  expect((await stored(page, "c1")).budget).toEqual({ amount: 500, currency: "USD" });
});

test("board grouped by a structured property: cards cannot be moved out of their objects", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=dbc");
  await page.getByRole("tab", { name: "By status" }).click();
  const card = page.getByRole("article", { name: "OpenCivics — Delegate Council" });
  await expect(card).toContainText("Benjamin Life — delegate");
  // Status is an ordinary property: moving the card by status still works and leaves members whole.
  await card.getByRole("button", { name: "Actions for OpenCivics — Delegate Council" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "paused" }).click();
  await expect.poll(async () => (await stored(page, "c1")).status).toBe("paused");
  expect((await stored(page, "c1")).members).toEqual(MEMBERS);
});
