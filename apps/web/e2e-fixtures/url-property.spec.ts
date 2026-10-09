import { test, expect, type Page } from "@playwright/test";

/**
 * A URL property holds web addresses only. Every editor of the value — a database cell,
 * the properties under the title, a bulk edit, the context panel — accepts and normalises
 * what is a web address, refuses what is not beside the field (nothing is written), and
 * shows a value that is already stored and is no address as plain text with "Not a link".
 * The rule itself is `lib/database/url.ts` (server test `url-property.test.ts`).
 * Fixtures: databases.html, context-properties.html?extra.
 */
const fx = (page: Page) => page.evaluate(() => (window as any).dbFixture);
const writes = async (page: Page) => ((await fx(page)).writes as any[]).filter((w: any) => !w.metadata?.prism_database);
const row = (page: Page, title: string) => page.locator("tr", { has: page.getByRole("button", { name: title, exact: true }) });
const row2 = row;
const REFUSED = "That isn’t a web address";
/** Give rows a stored `link` before the app reads them (the fixture keeps its notes in sessionStorage across a reload). */
async function seedLinks(page: Page, links: Record<string, string>) {
  await page.goto("/e2e-fixtures/databases.html");
  await expect(page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first()).toBeVisible();
  await page.evaluate((links) => {
    const notes = (window as any).dbFixture.notes();
    for (const [id, link] of Object.entries(links)) { const n = notes.find((x: any) => x.id === id); n.metadata = { ...n.metadata, link }; }
    sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
  }, links);
  await page.reload();
  await expect(page.getByRole("button", { name: "Refine onboarding copy", exact: true }).first()).toBeVisible();
}

test("database cell: a web address is saved (a bare domain gets https://); anything else is refused beside the cell and nothing is written", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto("/e2e-fixtures/databases.html");
  const r = row(page, "Update pricing page");
  await r.getByRole("button", { name: "Link: Empty" }).click();
  const input = page.getByRole("textbox", { name: "Link", exact: true });

  for (const typed of ["see the wiki", "hello", "javascript:alert(1)", "mailto:ada@example.test", "/page/abc", "https://user:pw@evil.test/x", "ftp://example.test/file"]) {
    await input.fill(typed);
    await input.press("Enter");
    const alert = r.getByRole("alert");
    await expect(alert, typed).toContainText(REFUSED);
    // The refusal is about the text: it is said to assistive tech on the field, and there is nothing to "retry".
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(input, "the text typed is still there to fix").toHaveValue(typed);
    expect(await writes(page), typed).toEqual([]);
  }
  // Leaving the field does not sneak the text in either.
  await page.getByRole("button", { name: "Sort", exact: true }).focus();
  expect(await writes(page)).toEqual([]);
  await expect(r.getByRole("alert")).toContainText(REFUSED);
  // Typing again clears the message; a bare domain is accepted and stored with its scheme.
  await input.fill("example.test/pricing");
  await expect(r.getByRole("alert")).toHaveCount(0);
  await input.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t5", set: { link: "https://example.test/pricing" }, expect: { link: null } });
  const link = r.getByRole("link", { name: "example.test/pricing" });
  await expect(link).toHaveAttribute("href", "https://example.test/pricing");
  await expect(link).toHaveAttribute("rel", /noopener/);
  // Surrounding blanks are not part of the address; an unchanged address is not a write.
  await r.getByRole("button", { name: "Link: https://example.test/pricing" }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("  https://example.test/pricing  ");
  await page.keyboard.press("Enter");
  await expect(r.getByRole("button", { name: "Link: https://example.test/pricing" })).toBeVisible();
  expect((await writes(page)).length).toBe(1);
  expect(JSON.stringify(await writes(page))).not.toContain("javascript:");
  expect(dialogs, "no browser prompt, alert or confirm").toEqual([]);
});

test("a value already stored that is no web address: plain text with a quiet “Not a link”, never a link — and it can be left, fixed or cleared", async ({ page }) => {
  await seedLinks(page, { t2: "see the wiki", t3: "example.test/no-scheme", t4: "javascript:alert(1)", t5: "https://user:pw@evil.test/x" });
  for (const [title, text] of [["Write release notes", "see the wiki"], ["Refine onboarding copy", "example.test/no-scheme"], ["Design new icon set", "javascript:alert(1)"], ["Update pricing page", "https://user:pw@evil.test/x"]] as const) {
    const r = row(page, title);
    const cell = r.locator("[data-not-link]");
    await expect(cell.locator(".db-not-link-text")).toHaveText(text);
    await expect(cell.locator(".db-not-link-hint")).toHaveText("Not a link");
    await expect(r.getByRole("button", { name: `Link: ${text} (not a link)` })).toBeVisible();
    await expect(r.getByRole("link")).toHaveCount(0);
  }
  await expect(page.locator('a[href^="javascript:" i], a[href*="evil.test"]')).toHaveCount(0);
  // A real address in the same column is still a link.
  await expect(row(page, "Review workspace navigation").getByRole("link", { name: "example.test/nav" })).toBeVisible();
  // The hint is quiet: smaller and muted beside the text.
  const hint = row(page, "Write release notes").locator(".db-not-link-hint");
  expect(await hint.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(13);

  // Left alone: opening the editor and pressing Enter writes nothing and does not complain.
  const wiki = row(page, "Write release notes");
  await wiki.getByRole("button", { name: /^Link: see the wiki/ }).click();
  const input = page.getByRole("textbox", { name: "Link", exact: true });
  await expect(input).toHaveValue("see the wiki");
  await input.press("Enter");
  await expect(wiki.getByRole("alert")).toHaveCount(0);
  await expect(wiki.getByRole("button", { name: /^Link: see the wiki/ })).toBeVisible();
  expect(await writes(page)).toEqual([]);
  // Changed to other text that is no address: refused, the stored value stays.
  await wiki.getByRole("button", { name: /^Link: see the wiki/ }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("see the handbook");
  await page.keyboard.press("Enter");
  await expect(wiki.getByRole("alert")).toContainText(REFUSED);
  expect(await writes(page)).toEqual([]);
  // Fixed.
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("https://wiki.example.test/home");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t2", set: { link: "https://wiki.example.test/home" }, expect: { link: "see the wiki" } });
  await expect(wiki.getByRole("link", { name: "wiki.example.test/home" })).toBeVisible();
  await expect(wiki.locator("[data-not-link]")).toHaveCount(0);
  // Saved again as it is, a scheme-less address becomes a link (the rule adds https://).
  const bare = row(page, "Refine onboarding copy");
  await bare.getByRole("button", { name: /^Link: example\.test\/no-scheme/ }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("example.test/no-scheme ");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t3", set: { link: "https://example.test/no-scheme" }, expect: { link: "example.test/no-scheme" } });
  // Cleared.
  const js = row(page, "Design new icon set");
  await js.getByRole("button", { name: /^Link: javascript/ }).click();
  await page.getByRole("textbox", { name: "Link", exact: true }).fill("");
  await page.keyboard.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t4", set: { link: null }, expect: { link: "javascript:alert(1)" } });
  await expect(js.getByRole("button", { name: "Link: Empty" })).toBeVisible();
});

test("bulk edit: a URL typed for several pages follows the same rule", async ({ page }) => {
  await page.goto("/e2e-fixtures/databases.html");
  const table = page.getByRole("table", { name: "All tasks" });
  await table.getByRole("checkbox", { name: "Select Refine onboarding copy" }).click();
  await table.getByRole("checkbox", { name: "Select Design new icon set" }).click();
  await page.getByRole("toolbar", { name: "Selected pages" }).getByRole("button", { name: "Edit property" }).click();
  const edit = page.getByRole("dialog", { name: "Edit property on selected pages" });
  await edit.getByLabel("Property to edit").selectOption("link");
  await edit.getByRole("button", { name: "Link: Empty" }).click();
  const input = edit.getByRole("textbox", { name: "Link", exact: true });
  await input.fill("not a link at all");
  await input.press("Enter");
  await expect(edit.getByRole("alert")).toContainText(REFUSED);
  expect((await fx(page)).batches).toEqual([]);
  await input.fill("example.test/shared");
  await input.press("Enter");
  await expect(page.locator(".db-toast")).toContainText("Updated Link on 2 pages.");
  expect((await fx(page)).batches.at(-1)).toEqual([
    { id: "t3", set: { link: "https://example.test/shared" }, expect: { link: null } },
    { id: "t4", set: { link: "https://example.test/shared" }, expect: { link: null } },
  ]);
});

test("properties under the title, on a phone: the refusal is readable and nothing is written", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/databases.html?open=t1");
  const props = page.getByRole("group", { name: "Page properties" });
  await props.getByRole("button", { name: "Link: https://example.test/nav" }).click();
  const input = page.getByRole("textbox", { name: "Link", exact: true });
  await input.fill("call me maybe");
  await input.press("Enter");
  const alert = props.getByRole("alert");
  await expect(alert).toContainText(REFUSED);
  const box = (await alert.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await writes(page)).toEqual([]);
  await input.fill("example.test/mobile");
  await input.press("Enter");
  expect((await writes(page)).at(-1)).toEqual({ id: "t1", set: { link: "https://example.test/mobile" }, expect: { link: "https://example.test/nav" } });
});

test("context panel: a free property that holds a web address takes web addresses only", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-properties.html?extra");
  const site = page.getByRole("textbox", { name: "Website", exact: true });
  await expect(site).toHaveValue("https://example.test/brief");
  const count = () => page.evaluate(() => (window as any).contextProperties.writes.length);
  await site.fill("ask Alex for the link");
  await site.press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: REFUSED });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(site).toHaveAttribute("aria-invalid", "true");
  expect(await count()).toBe(0);
  await site.fill("example.test/brief-v2");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await site.press("Enter");
  await expect.poll(count).toBe(1);
  expect(await page.evaluate(() => (window as any).contextNote().metadata.website)).toBe("https://example.test/brief-v2");
  // A property that is ordinary text is not held to the rule.
  const owner = page.getByRole("textbox", { name: "Owner", exact: true });
  await owner.fill("see the wiki");
  await owner.press("Enter");
  await expect.poll(count).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the server's refusal is shown inline too: in the context panel's free-property row and in a database cell — as the rule's own message, with nothing to retry", async ({ page }) => {
  // Context panel: "Owner" is plain text for this client, but the server knows better (another writer made it a URL property).
  await page.goto("/e2e-fixtures/context-properties.html?extra");
  const owner = page.getByRole("textbox", { name: "Owner", exact: true });
  await page.evaluate(() => { (window as any).contextProperties.refuseUrl = "owner"; });
  await owner.fill("ask Alex");
  await owner.press("Enter");
  const row = page.locator(".prism-context-property-row", { has: owner });
  const alert = row.getByRole("alert");
  await expect(alert).toContainText(REFUSED);
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(owner).toHaveAttribute("aria-invalid", "true");
  await expect(owner, "what was typed is still there to fix").toHaveValue("ask Alex");
  // Not the panel's generic "could not be saved. Check your access" banner: this is about the value.
  await expect(page.getByText("Check your access and try again")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).contextNote().metadata.owner)).toBe("Alex Chen");
  // Typing clears the message; once the server accepts, the value is saved.
  await page.evaluate(() => { (window as any).contextProperties.refuseUrl = ""; });
  await owner.fill("https://example.test/alex");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await owner.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).contextNote().metadata.owner)).toBe("https://example.test/alex");

  // Database cell: the client let it through (a real address), the server refuses anyway — same inline message.
  await page.goto("/e2e-fixtures/databases.html");
  const r = row2(page, "Update pricing page");
  await r.getByRole("button", { name: "Link: Empty" }).click();
  await page.evaluate(() => { (window as any).dbFixture.refuseUrlNext = true; });
  const input = page.getByRole("textbox", { name: "Link", exact: true });
  await input.fill("https://example.test/refused-by-server");
  await input.press("Enter");
  await expect(r.getByRole("alert")).toContainText(REFUSED);
  await expect(r.getByRole("alert").getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(input).toHaveValue("https://example.test/refused-by-server");
  await input.fill("https://example.test/accepted");
  await input.press("Enter");
  await expect(r.getByRole("link", { name: "example.test/accepted" })).toBeVisible();
});
