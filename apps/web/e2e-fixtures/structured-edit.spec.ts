import { test, expect, type Page } from "@playwright/test";
import { touchTargets } from "./a11y-measure";

/**
 * The structured-value dialog: a property that holds a list of objects
 * (`members: [{name, role}]`) is edited as rows (items) × columns (their fields) and
 * written back in exactly the same shape through the structured route — nothing the
 * dialog does not show is lost. The model and the server route are tested without a
 * browser (`apps/server/test/structured-edit.test.ts`); this is the dialog itself.
 * Fixture: databases.html?circles[=rich], context-properties.html?extra.
 */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const stored = (page: Page, id: string) => page.evaluate((i) => (window as any).dbFixture.notes().find((n: any) => n.id === i).metadata, id);
const bar = (page: Page) => page.getByRole("group", { name: "Page properties" });
const dialogOf = (page: Page, label = "Members") => page.getByRole("dialog", { name: `Edit ${label}` });
const RICH = [
  { name: "Benjamin Life", role: "delegate", since: 2021, active: true, contact: { email: "b@example.test", phones: ["1", "2"] }, tags: ["core", "ops"] },
  { role: "observer", name: "Patricia Parkinson", page: "[[People/Sam Rivera]]", note: null },
  "a plain line",
];
/** Fail the test on any browser prompt / confirm / alert. */
function noBrowserDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(`${d.type()}: ${d.message()}`); void d.dismiss(); });
  return seen;
}

test("property bar: Edit… opens rows × columns; a cell edit, a new row, a reorder and a removal are saved in the same shape", async ({ page }, info) => {
  const browserDialogs = noBrowserDialogs(page);
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  const members = bar(page).locator('[data-property-key="members"]');
  const edit = members.getByRole("button", { name: "Edit Members" });
  await expect(edit).toHaveText("Edit…");
  await expect(edit).toHaveAttribute("aria-haspopup", "dialog");
  await edit.click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  // Rows are the items, columns the fields they have.
  const table = dialog.getByRole("table", { name: "Members items" });
  await expect(table.locator("thead th")).toHaveText(["Item#", "Name", "Role", "Actions"]);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(dialog.getByRole("textbox", { name: "Name of item 1" })).toHaveValue("Benjamin Life");
  await expect(dialog.getByRole("textbox", { name: "Role of item 2" })).toHaveValue("delegate");
  // Focus is inside; nothing has changed yet, so Save has nothing to do.
  await expect(dialog.getByRole("textbox", { name: "Name of item 1" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("structured-dialog.png") });

  // Change a cell, add a row, move it up, remove another.
  await dialog.getByRole("textbox", { name: "Role of item 2" }).fill("chair");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  const newName = dialog.getByRole("textbox", { name: "Name of item 3" });
  await expect(newName).toBeFocused();
  await newName.fill("Mira Chen");
  await dialog.getByRole("textbox", { name: "Role of item 3" }).fill("delegate");
  await dialog.getByRole("button", { name: "Move item 3 up" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name of item 2" })).toHaveValue("Mira Chen");
  await expect(dialog.getByRole("status")).toHaveText("Item 3 moved to position 2 of 3.");
  await dialog.getByRole("button", { name: "Remove item 1" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(dialog.getByRole("textbox", { name: "Name of item 1" })).toHaveValue("Mira Chen");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const want = [{ name: "Mira Chen", role: "delegate" }, { name: "Patricia Parkinson", role: "chair" }];
  const f = await fx(page);
  // ONE write, through the structured route, over exactly the value that was loaded.
  expect(f.structuredWrites).toEqual([{ id: "c1", key: "members", value: want, expect: [{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }] }]);
  expect(f.writes).toEqual([]);
  expect(JSON.stringify((await stored(page, "c1")).members)).toBe(JSON.stringify(want));
  // The page shows the new value, and focus is back on the button that opened the dialog.
  await expect(members.locator(".db-chips > *")).toHaveText(["MMira Chen — delegate", "Patricia Parkinson — chair"]); // "M": Mira is a person page, drawn with her initial
  await expect(members.getByRole("button", { name: "Edit Members" })).toBeFocused();
  // The other properties of the page were not touched.
  expect((await stored(page, "c1")).budget).toEqual({ amount: 500, currency: "USD" });
  expect((await stored(page, "c1")).sponsors).toEqual([{ person: "[[People/Mira Chen]]", role: "sponsor" }]);
  expect(browserDialogs).toEqual([]);
});

test("fidelity: nested fields, a field on one row only, each row's field order and a plain line all survive an edit", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles=rich&open=c3");
  await bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  const table = dialog.getByRole("table", { name: "Members items" });
  // Every field any item has is a column, in the order first seen.
  await expect(table.locator("thead th")).toHaveText(["Item#", "Name", "Role", "Since", "Active", "Contact", "Tags", "Page", "Note", "Actions"]);
  // Typed cells: a number, a yes/no; nested values are summarised and said to be kept.
  await expect(dialog.getByRole("textbox", { name: "Since of item 1" })).toHaveValue("2021");
  await expect(dialog.getByRole("checkbox", { name: "Active of item 1" })).toBeChecked();
  const row1 = table.locator("tbody tr").nth(0);
  await expect(row1.locator("[data-sv-kept]")).toHaveCount(2);
  await expect(row1.locator("[data-sv-kept]").first()).toContainText("b@example.test");
  await expect(row1.locator("[data-sv-kept]").first()).toContainText("kept as it is");
  // The plain line is one editable value across the row.
  await expect(dialog.getByRole("textbox", { name: "Value of item 3" })).toHaveValue("a plain line");

  // 1) Saving with no edit writes NOTHING.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await fx(page)).structuredWrites).toEqual([]);

  // 2) Edit one text cell, one number, one checkbox — and type into an empty cell then clear it again (not a change).
  await bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" }).click();
  await dialog.getByRole("textbox", { name: "Name of item 2" }).fill("Patricia P.");
  await dialog.getByRole("textbox", { name: "Since of item 1" }).fill("2019");
  await dialog.getByRole("checkbox", { name: "Active of item 1" }).uncheck();
  const emptySince = dialog.getByRole("textbox", { name: "Since of item 2" });
  await emptySince.fill("2030");
  await emptySince.fill("");
  const emptyNote = dialog.getByRole("textbox", { name: "Note of item 1" });
  await emptyNote.fill("temp");
  await emptyNote.fill("");
  await dialog.getByRole("checkbox", { name: "Active of item 2" }).check();
  await dialog.getByRole("checkbox", { name: "Active of item 2" }).uncheck();
  // A number field refuses text that is no number, and Save waits for it.
  await dialog.getByRole("textbox", { name: "Since of item 1" }).fill("last year");
  await expect(dialog.getByRole("alert").filter({ hasText: "That isn’t a number." })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Since of item 1" }).fill("2019");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const want = [
    { name: "Benjamin Life", role: "delegate", since: 2019, active: false, contact: { email: "b@example.test", phones: ["1", "2"] }, tags: ["core", "ops"] },
    { role: "observer", name: "Patricia P.", page: "[[People/Sam Rivera]]", note: null },
    "a plain line",
  ];
  // Compared as TEXT: the order of every item's fields is part of what must be kept.
  expect(JSON.stringify((await stored(page, "c3")).members)).toBe(JSON.stringify(want));
  const sent = (await fx(page)).structuredWrites.at(-1);
  expect(JSON.stringify(sent.value)).toBe(JSON.stringify(want));
  expect(JSON.stringify(sent.expect)).toBe(JSON.stringify(RICH));
});

test("a field that holds a page link offers the page picker; choosing a page stores [[its path]]", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles=rich&open=c3");
  await bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByRole("textbox", { name: "Page of item 2" })).toHaveValue("[[People/Sam Rivera]]");
  // Only the link column has a picker.
  await expect(dialog.getByRole("button", { name: /^Link a page for/ })).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Link a page for Role of item 1" })).toHaveCount(0);
  const pick1 = dialog.getByRole("button", { name: "Link a page for Page of item 1" });
  await pick1.click();
  await expect(pick1).toHaveAttribute("aria-expanded", "true");
  // The page list is part of the dialog (a modal makes everything outside it inert).
  const picker = dialog.getByRole("group", { name: "Link a page for Page of item 1" });
  const search = picker.getByRole("textbox", { name: "Search pages" });
  await expect(search).toBeFocused();
  await search.fill("Mira");
  await picker.getByRole("option", { name: /Mira Chen/ }).click();
  await expect(picker).toHaveCount(0);
  // The list closed; the dialog is still open with the link in the field, and focus is back on the cell's button.
  await expect(dialog.getByRole("textbox", { name: "Page of item 1" })).toHaveValue("[[People/Mira Chen]]");
  await expect(pick1).toBeFocused();
  // Escape with the list open closes the list only.
  const pick2 = dialog.getByRole("button", { name: "Link a page for Page of item 2" });
  await pick2.click();
  await expect(dialog.getByRole("group", { name: "Link a page for Page of item 2" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("group", { name: "Link a page for Page of item 2" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(pick2).toBeFocused();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await stored(page, "c3")).members;
  // The new field went LAST on that row; the row that already had it is untouched.
  expect(Object.keys(saved[0])).toEqual(["name", "role", "since", "active", "contact", "tags", "page"]);
  expect(saved[0].page).toBe("[[People/Mira Chen]]");
  expect(JSON.stringify(saved[1])).toBe(JSON.stringify(RICH[1]));
  // On the page the item is now a link to the page it was given (a chip is named by the page it opens).
  await expect(bar(page).locator('[data-property-key="members"]').getByRole("link", { name: /Mira Chen/ })).toBeVisible();
});

test("keyboard: Enter opens it, Tab stays inside, Escape with changes asks before discarding, focus returns to Edit…", async ({ page }) => {
  const browserDialogs = noBrowserDialogs(page);
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  const edit = bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" });
  await edit.focus();
  await page.keyboard.press("Enter");
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // Tab from the last control wraps to the first, Shift+Tab from the first to the last: focus never leaves the dialog.
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    // (A modal lets Tab pass through the browser's own chrome between its last and first control; the page behind is never reached.)
    expect(await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || !!a.closest("dialog[open][data-structured-dialog]"); }), `Tab ${i + 1}`).toBe(true);
  }
  // The page behind is inert while the dialog is open: its controls cannot be clicked or focused.
  expect(await page.evaluate(() => { const b = document.querySelector<HTMLElement>('[data-property-key="status"] button'); b?.focus(); return document.activeElement === b; })).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("textbox", { name: "Name of item 1" })).toBeFocused();
  // Every control has a name.
  const unnamed = await dialog.locator("input, button").evaluateAll((els) => els.filter((el) => !(el.getAttribute("aria-label") || el.textContent || "").trim()).length);
  expect(unnamed).toBe(0);
  // Escape without changes closes at once.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();

  // With changes, Escape asks IN the dialog (never a browser confirm); "Keep editing" keeps them.
  await page.keyboard.press("Enter");
  await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
  await page.keyboard.press("Escape");
  const ask = dialog.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(ask).toContainText("Discard your changes to Members?");
  await expect(ask.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Role of item 1" })).toHaveValue("chair");
  // The typing did not reach the page behind (no tab switch, no row opened, no write).
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect((await fx(page)).structuredWrites).toEqual([]);
  expect((await stored(page, "c1")).members).toEqual([{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }]);
  expect(browserDialogs).toEqual([]);
});

test("changed elsewhere while editing: the save is refused with what is stored now — show the latest, or save mine anyway", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  const members = bar(page).locator('[data-property-key="members"]');
  await members.getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
  const theirs = [{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }, { name: "Added By Sync", role: "guest" }];
  await page.evaluate((t) => { (window as any).dbFixture.conflictWith = t; }, theirs);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = dialog.locator("[data-conflict]");
  await expect(conflict).toContainText("Members was changed somewhere else while you were editing.");
  await expect(conflict).toContainText("Added By Sync — guest");
  // Nothing of mine was written over theirs, and my edit is still in the dialog.
  expect((await stored(page, "c1")).members).toEqual(theirs);
  await expect(dialog.getByRole("textbox", { name: "Role of item 1" })).toHaveValue("chair");

  // "Show the latest": the dialog now edits what is stored (three items), my edit is gone.
  await conflict.getByRole("button", { name: "Show the latest (discard mine)" }).click();
  await expect(dialog.getByRole("table", { name: "Members items" }).locator("tbody tr")).toHaveCount(3);
  await expect(dialog.getByRole("textbox", { name: "Role of item 1" })).toHaveValue("delegate");
  await expect(dialog.locator("[data-conflict]")).toHaveCount(0);
  // An edit on top of the latest lands, compared against the latest.
  await dialog.getByRole("textbox", { name: "Role of item 3" }).fill("member");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const merged = [...theirs.slice(0, 2), { name: "Added By Sync", role: "member" }];
  expect((await stored(page, "c1")).members).toEqual(merged);
  expect((await fx(page)).structuredWrites.at(-1).expect).toEqual(theirs);

  // "Save mine anyway": my version replaces theirs, on purpose, compared against theirs.
  await members.getByRole("button", { name: "Edit Members" }).click();
  await dialog.getByRole("button", { name: "Remove item 3" }).click();
  const again = [...merged, { name: "Second Sync", role: "guest" }];
  await page.evaluate((t) => { (window as any).dbFixture.conflictWith = t; }, again);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.locator("[data-conflict]").getByRole("button", { name: "Save mine anyway" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await stored(page, "c1")).members).toEqual(merged.slice(0, 2));
  expect((await fx(page)).structuredWrites.at(-1)).toEqual({ id: "c1", key: "members", value: merged.slice(0, 2), expect: again });
});

test("changed elsewhere into plain text: the dialog says so and will not write objects over it", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  await bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
  await page.evaluate(() => { (window as any).dbFixture.conflictWith = ["[[People/Mira Chen]]"]; });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = dialog.locator("[data-conflict]");
  await expect(conflict).toContainText("is no longer a list of items");
  await expect(conflict.getByRole("button")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect((await stored(page, "c1")).members).toEqual(["[[People/Mira Chen]]"]);
});

test("a failed save keeps the edits and says why; saving again works", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  await bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Role of item 2" }).fill("treasurer");
  await page.evaluate(() => { (window as any).dbFixture.failNext = true; });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Not saved. Your changes are still here; try again.");
  await expect(dialog.getByRole("textbox", { name: "Role of item 2" })).toHaveValue("treasurer");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await stored(page, "c1")).members[1]).toEqual({ name: "Patricia Parkinson", role: "treasurer" });
});

test("a row added and left empty is not saved; removing every item leaves an empty list", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=c1");
  const members = bar(page).locator('[data-property-key="members"]');
  await members.getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("button", { name: "Add item" }).click();
  await dialog.getByRole("button", { name: "Add item" }).click();
  await dialog.getByRole("textbox", { name: "Name of item 4" }).fill("Only This One");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The new item has the same fields as its neighbours (the role it was not given is empty text), the blank row is dropped.
  expect((await stored(page, "c1")).members).toEqual([{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }, { name: "Only This One", role: "" }]);

  await members.getByRole("button", { name: "Edit Members" }).click();
  for (let i = 0; i < 3; i++) await dialog.getByRole("button", { name: "Remove item 1" }).click();
  await expect(dialog.locator("[data-sv-empty]")).toHaveText("No items. Saving leaves an empty list.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await stored(page, "c1")).members).toEqual([]);
  expect((await fx(page)).structuredWrites.at(-1).value).toEqual([]);
});

test("database table: Edit… in the cell opens the same dialog; the row does not open and the grid does not move while typing", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&open=dbc");
  const row = page.locator("tr", { has: page.getByRole("button", { name: "OpenCivics — Delegate Council", exact: true }) });
  const tabsBefore = await page.evaluate(() => (window as any).prismUI.getState().openTabs.length);
  await row.getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // Sponsors — {person: [[link]], role} — has its own Edit… too, with a people picker on the person field.
  const role = dialog.getByRole("textbox", { name: "Role of item 1" });
  await role.fill("chair");
  // Arrow keys, Enter and Space typed in the dialog stay in the dialog.
  await role.press("ArrowDown");
  await role.press("ArrowRight");
  await role.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(role).toBeFocused();
  expect(await page.evaluate(() => (window as any).prismUI.getState().openTabs.length)).toBe(tabsBefore);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Benjamin Life — chair");
  expect((await stored(page, "c1")).members).toEqual([{ name: "Benjamin Life", role: "chair" }, { name: "Patricia Parkinson", role: "delegate" }]);

  await row.getByRole("button", { name: "Edit Sponsors" }).click();
  const sponsors = dialogOf(page, "Sponsors");
  await expect(sponsors.getByRole("textbox", { name: "Person of item 1" })).toHaveValue("[[People/Mira Chen]]");
  await sponsors.getByRole("button", { name: "Link a page for Person of item 1" }).click();
  // A people-named field lists people (pages tagged #person) without typing.
  const picker = sponsors.getByRole("group", { name: "Link a page for Person of item 1" });
  await expect(picker.getByRole("textbox", { name: "Search people" })).toBeFocused();
  await picker.getByRole("option", { name: /Sam Rivera/ }).click();
  await sponsors.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sponsors).toHaveCount(0);
  expect((await stored(page, "c1")).sponsors).toEqual([{ person: "[[People/Sam Rivera]]", role: "sponsor" }]);
  // A plain list in the same column is still edited inline, by its own editor.
  const plain = page.locator("tr", { has: page.getByRole("button", { name: "Stewards", exact: true }) });
  await expect(plain.getByRole("button", { name: "Members: facilitation" })).toBeVisible();
  await expect(plain.getByRole("button", { name: "Edit Members" })).toHaveCount(0);
});

test("someone who can only view sees no Edit…; a member who may edit the row gets it and saves through the same route", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&viewer&open=dbc");
  const row = page.locator("tr", { has: page.getByRole("button", { name: "OpenCivics — Delegate Council", exact: true }) });
  await expect(row).toContainText("Benjamin Life — delegate");
  await expect(row.getByRole("button", { name: "Edit Members" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit (Members|Sponsors)$/ })).toHaveCount(0);
  // The same member is given edit access to this page (the server says so per row).
  await page.evaluate(() => { const n = (window as any).dbFixture.notes().find((x: any) => x.id === "c1"); n._caps = ["view", "edit"]; });
  await page.getByRole("button", { name: "Members", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Sort ascending" }).click();
  await expect(row.getByRole("button", { name: "Edit Members" })).toBeVisible();
  // The row they still cannot edit has none.
  await row.getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Role of item 2" }).fill("observer");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await stored(page, "c1")).members[1]).toEqual({ name: "Patricia Parkinson", role: "observer" });
  // If the server refuses after all (access was taken away meanwhile), it is said and nothing is lost.
  await row.getByRole("button", { name: "Edit Members" }).click();
  await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
  await page.evaluate(() => { const n = (window as any).dbFixture.notes().find((x: any) => x.id === "c1"); n._caps = ["view"]; });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("You can’t edit this page. Nothing was saved.");
  await expect(dialog.getByRole("textbox", { name: "Role of item 1" })).toHaveValue("chair");
  expect((await stored(page, "c1")).members[0]).toEqual({ name: "Benjamin Life", role: "delegate" });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("390 px: the dialog fills the screen, each item is a card of labelled fields, every control is finger-sized, nothing scrolls sideways", async ({ page }, info) => {
    await page.goto("/e2e-fixtures/databases.html?circles=rich&open=c3");
    const edit = bar(page).locator('[data-property-key="members"]').getByRole("button", { name: "Edit Members" });
    const eb = (await edit.boundingBox())!;
    expect(eb.height).toBeGreaterThanOrEqual(44);
    expect(eb.width).toBeGreaterThanOrEqual(44);
    await edit.tap();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(0.5);
    expect(box.width).toBeGreaterThanOrEqual(389);
    // No sideways scrolling anywhere: not the page, not the dialog, not the item list.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await dialog.locator(".db-sv-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Each field shows its name above it (the column headers are not visible on a phone).
    const first = dialog.locator("tbody tr").first();
    await expect(first.locator(".db-sv-cell-label").first()).toBeVisible();
    await expect(first.locator(".db-sv-cell-label").first()).toHaveText("Name");
    // Fields: 44 px tall, 16 px text (no zoom on focus), inside the screen.
    for (const input of await dialog.getByRole("textbox").all()) {
      const b = (await input.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390.5);
      expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    }
    for (const b of await dialog.getByRole("button").all()) {
      const r = (await b.boundingBox())!;
      expect(r.height, await b.getAttribute("aria-label") ?? await b.textContent() ?? "").toBeGreaterThanOrEqual(44);
    }
    expect(await touchTargets(page)).toEqual([]);
    await page.screenshot({ path: info.outputPath("structured-dialog-390.png"), fullPage: false });
    // It works by touch: change, add, save.
    await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
    await dialog.getByRole("button", { name: "Add item" }).tap();
    await dialog.getByRole("textbox", { name: "Name of item 4" }).fill("New Member");
    await dialog.getByRole("button", { name: "Save", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    const saved = (await stored(page, "c3")).members;
    expect(saved[0].role).toBe("chair");
    expect(saved[0].contact).toEqual({ email: "b@example.test", phones: ["1", "2"] });
    expect(saved[2]).toBe("a plain line");
    // Shaped like the item above it (which holds `note` as nothing): same fields, same order.
    expect(JSON.stringify(saved[3])).toBe(JSON.stringify({ role: "", name: "New Member", page: "", note: null }));
  });
});

test("a shell without the structured route (legacy): the same compare-and-set through a metadata-only write", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html?circles&legacy&open=c1");
  const members = bar(page).locator('[data-property-key="members"]');
  await members.getByRole("button", { name: "Edit Members" }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Role of item 1" }).fill("chair");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const want = [{ name: "Benjamin Life", role: "chair" }, { name: "Patricia Parkinson", role: "delegate" }];
  const w = (await fx(page)).writes.at(-1);
  // ONE key, guarded by the revision that was just read; the body is not sent.
  expect(w).toEqual({ id: "c1", metadata: { members: want }, ifUpdatedAt: "2026-10-01T12:00:00.000Z" });
  expect((await stored(page, "c1")).members).toEqual(want);
  // Changed elsewhere since the dialog opened: refused before anything is written.
  await members.getByRole("button", { name: "Edit Members" }).click();
  await dialog.getByRole("textbox", { name: "Role of item 2" }).fill("guest");
  await page.evaluate(() => { const n = (window as any).dbFixture.notes().find((x: any) => x.id === "c1"); n.metadata = { ...n.metadata, members: [{ name: "Someone Else", role: "x" }] }; });
  const before = (await fx(page)).writes.length;
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator("[data-conflict]")).toContainText("was changed somewhere else");
  expect((await fx(page)).writes.length).toBe(before);
  expect((await stored(page, "c1")).members).toEqual([{ name: "Someone Else", role: "x" }]);
});

test("context panel: a structured property has Edit… there too, and it keeps the nested fields", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-properties.html?extra");
  const panel = page.getByRole("region", { name: "Page properties" });
  await expect(panel).toContainText("Ada Park — lead");
  await expect(panel).not.toContainText("shown read-only");
  await panel.getByRole("button", { name: "Edit Reviewers" }).click();
  const dialog = dialogOf(page, "Reviewers");
  await expect(dialog.getByRole("table", { name: "Reviewers items" }).locator("thead th")).toHaveText(["Item#", "Name", "Role", "Notes", "Actions"]);
  await dialog.getByRole("textbox", { name: "Role of item 2" }).fill("approver");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const want = [{ name: "Ada Park", role: "lead", notes: { since: 2024 } }, { name: "Sam Rivera", role: "approver" }];
  expect(JSON.stringify(await page.evaluate(() => (window as any).contextNote().metadata.reviewers))).toBe(JSON.stringify(want));
  expect(await page.evaluate(() => (window as any).contextProperties.writes)).toEqual([{ kind: "structured", value: { key: "reviewers", value: want, expect: [{ name: "Ada Park", role: "lead", notes: { since: 2024 } }, { name: "Sam Rivera", role: "reader" }] } }]);
});
