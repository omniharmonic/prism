import { test, expect, type Page } from "@playwright/test";

/**
 * Project pages (Phase 0): a note tagged `project` at `vault/projects/<slug>/PROJECT`
 * opens on the ordinary document surface. The page used to print the word "PROJECT"
 * as its title and the first body line as raw text ("**Status:**", "[[Ada Park]]").
 * Fixture: `project-pages.html` (the real workspace over an in-page fake server).
 * The live editor a signed-in person gets is covered by `project-pages-live.spec.ts`.
 */
const url = (q = "") => `/e2e-fixtures/project-pages.html${q}`;
const FOOD = "vault/projects/bioregional-food-chain/PROJECT";
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const tree = (page: Page) => nav(page).getByRole("region", { name: "Pages", exact: true });
const row = (page: Page, name: string) => tree(page).getByRole("button", { name, exact: true });
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open document tabs" });
const body = (page: Page) => page.locator(".tiptap").first();
type Write = Record<string, unknown>;
const writes = (page: Page) => page.evaluate(() => (window as unknown as { prismFixtureWrites: Write[] }).prismFixtureWrites);
const pathOf = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { prismFixtureNotes: Array<{ id: string; path: string }> }).prismFixtureNotes.find((n) => n.id === i)?.path, id);
const noteOf = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { prismFixtureNotes: Array<{ id: string; content: string; metadata: Record<string, unknown> }> }).prismFixtureNotes.find((n) => n.id === i), id);
async function expand(page: Page, name: string) {
  const toggle = tree(page).getByRole("button", { name: `Expand ${name}`, exact: true });
  await expect(toggle.or(tree(page).getByRole("button", { name: `Collapse ${name}`, exact: true }))).toBeVisible();
  if (await toggle.count()) await toggle.click();
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });
/** Open a page of the fixture and wait until the workspace and its body are on screen. */
async function open(page: Page, id: string) {
  await page.goto(url(`?open=${id}`));
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
  await expect(body(page)).toBeVisible({ timeout: 30_000 });
  await expect(body(page)).not.toBeEmpty({ timeout: 30_000 });
}

test("a project page shows a real title in the header, the tab and the tree — never the word PROJECT", async ({ page }) => {
  await open(page, "food");
  await expect(page.getByRole("heading", { level: 1, name: "Rename Bioregional food chain", exact: true })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Bioregional food chain", exact: true })).toBeVisible();
  await expand(page, "projects");
  await expand(page, "bioregional-food-chain");
  await expect(row(page, "Bioregional food chain")).toBeVisible();
  await expect(row(page, "Call the growers")).toBeVisible(); // an ordinary page beside it keeps its own name
  await expect(page.getByText("PROJECT", { exact: true })).toHaveCount(0);
  await expect(tree(page).getByText("PROJECT", { exact: true })).toHaveCount(0);
  // The breadcrumb is the page's real location.
  await expect(page.getByRole("navigation", { name: "Document location" }).first()).toContainText("bioregional-food-chain");
});

test("`metadata.name` names a project page that has no title", async ({ page }) => {
  await open(page, "named");
  await expect(page.getByRole("heading", { level: 1, name: "Rename Watershed Council", exact: true })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Watershed Council", exact: true })).toBeVisible();
  await expand(page, "projects");
  await expand(page, "watershed");
  await expect(row(page, "Watershed Council")).toBeVisible();
});

test("the Markdown body renders as formatted text, with the property bar under the title", async ({ page }) => {
  await open(page, "food");
  const doc = body(page);
  await expect(doc.locator("h1", { hasText: "Bioregional Food Chain" })).toBeVisible();
  await expect(doc.locator("strong", { hasText: "Status:" })).toBeVisible();
  await expect(doc.locator("em", { hasText: "working agreement" })).toBeVisible();
  await expect(doc.locator("h2", { hasText: "Goals" })).toBeVisible();
  await expect(doc.locator("li", { hasText: "Map every grower" })).toBeVisible();
  await expect(doc.locator("blockquote")).toContainText("speed of trust");
  await expect(doc.locator("code", { hasText: "supply.csv" })).toBeVisible();
  // No Markdown as typed: no asterisks or heading marks; the wikilink shows its name, not its brackets.
  const shown = await doc.evaluate((el) => (el as HTMLElement).innerText);
  expect(shown).not.toContain("**");
  expect(shown).not.toMatch(/^#/m);
  const link = doc.locator(".wikilink").first();
  await expect(link).toBeVisible();
  expect(await link.evaluate((el) => getComputedStyle(el).fontSize)).toBe("0px"); // the brackets are not drawn…
  expect(await link.evaluate((el) => getComputedStyle(el, "::after").content)).toContain("Ada Park"); // …the name is
  // Properties: the typed bar, as on any tagged page.
  const props = page.getByRole("group", { name: "Page properties" });
  await expect(props).toBeVisible();
  await expect(props).toContainText(/status/i);
  await expect(props).toContainText(/active/i);
  await expect(props).toContainText("project");
  // The old page's counters are gone, and the vault is not downloaded to draw this page.
  await expect(page.getByText(/Tasks\s*0|Documents\s*0/)).toHaveCount(0);
});

test("opening a project page writes nothing; typing in it saves the body", async ({ page }) => {
  await open(page, "food");
  const before = await noteOf(page, "food");
  await expect(body(page).locator("strong", { hasText: "Status:" })).toBeVisible();
  await page.waitForTimeout(3200); // past the 2 s autosave debounce
  expect((await writes(page)).filter((w) => w.patch === "food")).toEqual([]);
  expect((await noteOf(page, "food"))!.content).toBe(before!.content); // the stored Markdown is untouched
  // Editable.
  await expect(body(page)).toHaveAttribute("contenteditable", "true");
  await body(page).locator("blockquote").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed in the project page.");
  await expect(body(page)).toContainText("Typed in the project page.");
  await expect.poll(async () => (await noteOf(page, "food"))!.content, { timeout: 10_000 }).toContain("Typed in the project page.");
  const saved = (await noteOf(page, "food"))!;
  for (const kept of ["Bioregional Food Chain", "Status:", "Map every grower", "speed of trust", "Ada Park"]) expect(saved.content).toContain(kept);
  expect(await pathOf(page, "food")).toBe(FOOD);
  expect(saved.metadata.status).toBe("active");
});

test("editing the title stores `metadata.title`: the file PROJECT and its folder do not move", async ({ page }) => {
  await open(page, "food");
  await page.getByRole("button", { name: "Rename Bioregional food chain", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await expect(title).toHaveValue("Bioregional food chain");
  await title.fill("Front Range Food Chain");
  await title.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Rename Front Range Food Chain", exact: true })).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: "Open Front Range Food Chain", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const sent = await writes(page);
  expect(sent.some((w) => "move" in w)).toBe(false);
  expect(sent.some((w) => typeof w.path === "string")).toBe(false);
  expect(sent.filter((w) => w.patch === "food").map((w) => w.metadata)).toEqual([{ title: "Front Range Food Chain" }]);
  expect(sent.some((w) => w.patch === "food" && typeof w.content === "string")).toBe(false); // the body was not sent
  expect(await pathOf(page, "food")).toBe(FOOD);
  expect(await pathOf(page, "task1")).toBe("vault/projects/bioregional-food-chain/Call the growers");
  const stored = (await noteOf(page, "food"))!;
  expect(stored.metadata).toMatchObject({ title: "Front Range Food Chain", status: "active", lead: "Ada Park" });
  // The tree follows, still under the same folder; a reload shows the same title everywhere.
  await expand(page, "projects");
  await expand(page, "bioregional-food-chain");
  await expect(row(page, "Front Range Food Chain")).toBeVisible();
});

test("the tree's Rename on a project page stores the title too, and moves nothing", async ({ page }) => {
  await open(page, "task1");
  await expand(page, "projects");
  await expand(page, "bioregional-food-chain");
  await nav(page).getByRole("button", { name: "Page actions for Bioregional food chain", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const field = tree(page).getByRole("textbox", { name: "Rename Bioregional food chain" });
  await expect(field).toHaveValue("Bioregional food chain");
  await field.fill("Food Web");
  await field.press("Enter");
  await expect(row(page, "Food Web")).toBeVisible();
  const sent = await writes(page);
  expect(sent.some((w) => "move" in w)).toBe(false);
  expect(sent.filter((w) => w.patch === "food").map((w) => w.metadata)).toEqual([{ title: "Food Web" }]);
  expect(await pathOf(page, "food")).toBe(FOOD);
});

test("an ordinary page beside a project still renames by moving its file", async ({ page }) => {
  await open(page, "task1");
  await page.getByRole("button", { name: "Rename Call the growers", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Document title" });
  await title.fill("Call every grower");
  await title.press("Enter");
  await expect.poll(() => pathOf(page, "task1")).toBe("vault/projects/bioregional-food-chain/Call every grower");
  expect((await writes(page)).some((w) => w.move === "task1")).toBe(true);
});

test("a 53,000-character Markdown project body opens formatted and writes nothing", async ({ page }) => {
  await open(page, "big");
  const started = Date.now();
  const doc = body(page);
  await expect(doc.locator("h1", { hasText: "Front Range Commons" })).toBeVisible({ timeout: 20_000 });
  const stored = (await noteOf(page, "big"))!.content;
  expect(stored.length).toBeGreaterThanOrEqual(53_000);
  const sections = stored.match(/^## Section \d+/gm)!.length;
  await expect(doc.locator("h2")).toHaveCount(sections);
  await expect(doc.locator("table")).toHaveCount(sections);
  await expect(doc.locator("h2").last()).toHaveText(`Section ${sections}`);
  console.log(`[project-pages] ${stored.length}-char Markdown body rendered in ${Date.now() - started} ms after navigation`);
  expect(await doc.evaluate((el) => (el as HTMLElement).innerText.includes("**"))).toBe(false);
  await expect(page.getByRole("heading", { level: 1, name: "Rename Front range commons", exact: true })).toBeVisible();
  await page.waitForTimeout(3200);
  expect((await writes(page)).filter((w) => w.patch === "big")).toEqual([]);
  expect((await noteOf(page, "big"))!.content).toBe(stored);
});
