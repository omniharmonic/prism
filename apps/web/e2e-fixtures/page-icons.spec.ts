import { test, expect, type Page } from "@playwright/test";

/**
 * NP-PG-01 — custom page icons: an uploaded image (an attachment of THAT page, stored as
 * exactly `/api/attachments/<id>`) or a built-in icon in a colour, shown wherever the
 * page's icon shows. Real App + HttpVaultClient over the shell fixture's fake server,
 * which applies the server's icon rules (tree shape rule, own-attachment write rule).
 */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
const FILE = { name: "logo.png", mimeType: "image/png", buffer: PNG };
const FIRST = "/api/attachments/a_0000uploadedfileABCDEF";

/** Serve attachment bytes like the server would, counting requests per path. */
async function serveAttachments(page: Page, status = 200) {
  const hits: Record<string, number> = {};
  await page.route("**/api/attachments/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    return status === 200 ? route.fulfill({ status: 200, contentType: "image/png", body: PNG }) : route.fulfill({ status, body: "" });
  });
  return hits;
}
async function open(page: Page, query = "") {
  await page.goto(`/e2e-fixtures/notion-shell.html${query}`);
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
}
const icon = (page: Page, id = "workspace") => page.evaluate((noteId) => (window as any).prismShell.note(noteId).metadata.icon as string | null | undefined, id);
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open document tabs" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Page icon" });
const loaded = (page: Page, selector: string) => page.locator(selector).first().evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0);

async function uploadIcon(page: Page) {
  await page.getByRole("button", { name: /^(Add|Change) icon$/ }).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole("tab", { name: "Upload" }).click();
  await picker(page).getByLabel("Icon image file").setInputFiles(FILE);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("an uploaded image becomes the page icon in the header, tab, sidebar, favorites, ⌘K and breadcrumbs, and survives a reload", async ({ page }) => {
  const hits = await serveAttachments(page);
  await open(page);
  await expect(tabs(page).locator("[data-page-icon]")).toHaveCount(0);
  await uploadIcon(page);

  // Stored: the file is an attachment of THIS page, and metadata.icon is exactly its path.
  await expect.poll(() => icon(page)).toBe(FIRST);
  expect(await page.evaluate(() => (window as any).prismShell.uploads)).toEqual([{ noteId: "workspace", id: "a_0000uploadedfileABCDEF", name: "logo.png", type: "image/png", size: PNG.length, kind: "image" }]);
  await expect(picker(page)).toHaveCount(0);

  // Header tile.
  const tile = page.locator(".document-icon-control.has-icon");
  await expect(tile.locator("img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await expect(tile.locator("img.page-icon-img")).toHaveAttribute("alt", "");
  await expect.poll(() => loaded(page, ".document-icon-control.has-icon img.page-icon-img")).toBe(true);
  const box = (await tile.locator("img.page-icon-img").boundingBox())!;
  expect(Math.round(box.width)).toBe(Math.round(box.height));
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(await tile.locator("img.page-icon-img").evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0);

  // Tab + sidebar tree at once (no reload), small, square, rounded, decorative and lazy.
  const tabIcon = tabs(page).locator('[data-page-icon="workspace"] img.page-icon-img');
  await expect(tabIcon).toHaveAttribute("data-icon-src", FIRST);
  await expect(tabIcon).toHaveAttribute("loading", "lazy");
  await expect(tabIcon).toHaveAttribute("alt", "");
  const small = (await tabIcon.boundingBox())!;
  expect(small.width).toBeGreaterThanOrEqual(12);
  expect(small.width).toBeLessThanOrEqual(22);
  expect(Math.abs(small.width - small.height)).toBeLessThanOrEqual(1);
  const nav = page.locator(".workspace-navigation");
  await expect(nav.getByRole("region", { name: "Pages", exact: true }).locator("img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  // Favorites.
  await page.getByRole("button", { name: "Add to Favorites" }).click();
  await expect(nav.locator('[data-page-icon="workspace"] img.page-icon-img').first()).toHaveAttribute("data-icon-src", FIRST);
  // ⌘K result row.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("living");
  const row = page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /A living workspace/ }).first();
  await expect(row.locator("img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await expect(row).not.toContainText("/api/attachments");
  await page.keyboard.press("Escape");
  // Breadcrumbs of a sub-page.
  await page.evaluate(() => {
    (window as any).prismShell.serverCreate("Projects/Prism/A living workspace/Decisions", "<p>Decided.</p>");
    (window as any).prismShellUI.getState().openTab("foreign-1", "Decisions", "document");
  });
  await expect(page.getByRole("navigation", { name: "Document location" }).locator('[data-page-icon="workspace"] img.page-icon-img')).toHaveAttribute("data-icon-src", FIRST);
  // The path is never shown as text anywhere.
  await expect(page.getByText("/api/attachments/", { exact: false })).toHaveCount(0);

  // Drawn from a blob: URL — the credential never rides in an <img> URL, and the path is not a link.
  expect(await tabIcon.getAttribute("src")).toMatch(/^blob:/);
  // Many surfaces, ONE request: the file is fetched once per attachment, however often surfaces mount.
  await expect.poll(() => loaded(page, '.workspace-navigation img.page-icon-img')).toBe(true);
  expect(hits[FIRST]).toBe(1);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => (window as any).prismShellUI.getState().openTab("workspace", "A living workspace", "document"));
    await page.evaluate(() => (window as any).prismShellUI.getState().openTab("foreign-1", "Decisions", "document"));
  }
  await page.keyboard.press("ControlOrMeta+Backslash");
  await page.keyboard.press("ControlOrMeta+Backslash");
  await page.waitForTimeout(400);
  expect(hits[FIRST]).toBe(1);

  // "Another device": a fresh load reads the icon from the server's tree and the page.
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(tabs(page).locator('[data-page-icon="workspace"] img.page-icon-img').first()).toHaveAttribute("data-icon-src", FIRST);
  await expect(page.locator(".workspace-navigation img.page-icon-img").first()).toHaveAttribute("data-icon-src", FIRST);
});

test("an image icon can be replaced and removed; every surface follows", async ({ page }) => {
  await serveAttachments(page);
  await open(page);
  await uploadIcon(page);
  await expect.poll(() => icon(page)).toBe(FIRST);
  // Replace: the picker opens on Upload and shows the current image.
  await page.getByRole("button", { name: "Change icon" }).click();
  await expect(picker(page).getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
  await expect(picker(page).locator("img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await picker(page).getByLabel("Icon image file").setInputFiles({ ...FILE, name: "second.png" });
  const SECOND = "/api/attachments/a_0001uploadedfileABCDEF";
  await expect.poll(() => icon(page)).toBe(SECOND);
  await expect(tabs(page).locator('[data-page-icon="workspace"] img.page-icon-img')).toHaveAttribute("data-icon-src", SECOND);
  // Remove.
  await page.getByRole("button", { name: "Change icon" }).click();
  await picker(page).getByRole("button", { name: "Remove icon" }).click();
  await expect(page.getByRole("button", { name: "Add icon" })).toBeVisible();
  await expect.poll(async () => !(await icon(page))).toBe(true);
  await expect(tabs(page).locator('[data-page-icon="workspace"]')).toHaveCount(0);
  await expect(page.locator("img.page-icon-img")).toHaveCount(0);
});

test("only the page's own attachment is ever an image icon: other values are not drawn, not accepted from an upload, and a refused write is rolled back", async ({ page }) => {
  const hits = await serveAttachments(page);
  const outside: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1") && !r.url().startsWith("http://localhost") && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) outside.push(r.url()); });
  // What a tampered / hand-written note could hold: none of these is an icon.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("notion-shell-meta")) return;
    sessionStorage.setItem("notion-shell-meta", JSON.stringify({
      workspace: { icon: "https://evil.example/pixel.png" },
      agenda: { icon: "data:image/png;base64,iVBORw0KGgo=" },
      "field-notes": { icon: "/api/notes/agenda" },
      tracker: { icon: "/api/attachments/a_0000uploadedfileABCDEF?download=1" },
      blank: { icon: "//evil.example/pixel.png" },
    }));
  });
  await open(page);
  await expect(page.locator(".workspace-navigation").getByRole("region", { name: "Pages", exact: true })).toContainText("Workshop agenda");
  await expect(page.locator("img.page-icon-img")).toHaveCount(0);
  await expect(page.locator("[data-page-icon]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add icon" })).toBeVisible();
  for (const text of ["evil.example", "data:image", "/api/notes/agenda", "/api/attachments/"]) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("workshop");
  await expect(page.getByRole("group", { name: "Notes" }).getByRole("option").first()).toBeVisible();
  await expect(page.getByRole("option").locator("img")).toHaveCount(0);
  await expect(page.getByText("evil.example", { exact: false })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(outside).toEqual([]);
  expect(Object.keys(hits)).toEqual([]);

  // An upload that answers with anything but the page's attachment path is not taken as an icon.
  for (const answered of ["https://evil.example/pixel.png", "data:image/png;base64,iVBORw0KGgo=", "/api/notes/agenda", "/e2e-fixtures/media/cover.png"]) {
    await page.evaluate((url) => { (window as any).prismShell.uploadUrl = url; }, answered);
    const writes = await page.evaluate(() => (window as any).prismShell.writes.length);
    const sent = await page.evaluate(() => (window as any).prismShell.uploads.length);
    if (!(await picker(page).isVisible())) await uploadIcon(page);
    else await picker(page).getByLabel("Icon image file").setInputFiles(FILE);
    await expect.poll(() => page.evaluate(() => (window as any).prismShell.uploads.length)).toBe(sent + 1);
    await expect(picker(page).getByRole("alert")).toHaveText("The image could not be uploaded. Try again.");
    expect(await page.evaluate(() => (window as any).prismShell.writes.length)).toBe(writes);
    expect(await icon(page)).toBe("https://evil.example/pixel.png"); // untouched
    await expect(page.locator("img.page-icon-img")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);

  // A well-shaped path of ANOTHER page's file: the server refuses the write, and no surface keeps showing it.
  const foreign = await page.evaluate(() => (window as any).prismShell.serverAttachment("agenda") as string);
  await page.evaluate((url) => { (window as any).prismShell.uploadUrl = url; }, foreign);
  await uploadIcon(page);
  await expect.poll(() => page.evaluate(() => (window as any).prismShell.writes.filter((w: any) => w.method !== "GET" && JSON.stringify(w.body).includes("foreignfile")).length)).toBeGreaterThan(0);
  expect(await icon(page)).toBe("https://evil.example/pixel.png");
  await expect(tabs(page).locator('[data-page-icon="workspace"]')).toHaveCount(0);
  await expect(page.locator(".workspace-navigation img.page-icon-img")).toHaveCount(0);
  expect(outside).toEqual([]);
});

test("an image that cannot be loaded falls back to the default icon and can still be changed", async ({ page }) => {
  await serveAttachments(page, 404);
  await open(page);
  await uploadIcon(page);
  await expect.poll(() => icon(page)).toBe(FIRST);
  // No broken-image glyph anywhere: the tile shows the default icon, tabs and the tree their own.
  await expect(page.locator("img.page-icon-img")).toHaveCount(0);
  const tile = page.locator(".document-icon-control.has-icon");
  await expect(tile.locator("svg")).toBeVisible();
  await expect(page.locator(".workspace-navigation").getByRole("region", { name: "Pages", exact: true }).locator(".page-tree-icon svg").first()).toBeVisible();
  await tile.click();
  await picker(page).getByRole("button", { name: "Remove icon" }).click();
  await expect(page.getByRole("button", { name: "Add icon" })).toBeVisible();
});

test("a built-in icon in a colour is stored as an allowlisted token and shown everywhere", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add icon" }).click();
  await picker(page).getByRole("tab", { name: "Icons" }).click();
  // Keyboard: the tab list is one stop, arrows move between tabs.
  await picker(page).getByRole("tab", { name: "Icons" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(picker(page).getByRole("tab", { name: "Emoji" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(picker(page).getByRole("tab", { name: "Icons" })).toBeFocused();
  await picker(page).getByRole("radio", { name: "Blue" }).click();
  await expect(picker(page).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await picker(page).getByRole("button", { name: "Rocket icon" }).click();
  await expect.poll(() => icon(page)).toBe("icon:rocket:blue");
  const tabIcon = tabs(page).locator('[data-page-icon="workspace"][data-page-icon-kind="glyph"]');
  await expect(tabIcon.locator("svg")).toBeVisible();
  expect(await tabIcon.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(59, 130, 246)");
  await expect(page.locator(".document-icon-control.has-icon svg")).toBeVisible();
  await expect(page.locator(".workspace-navigation").getByRole("region", { name: "Pages", exact: true }).locator('[data-page-icon-kind="glyph"] svg')).toBeVisible();
  await expect(page.getByText("icon:rocket", { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await expect(tabs(page).locator('[data-page-icon="workspace"][data-page-icon-kind="glyph"] svg').first()).toBeVisible();
  // The picker reopens on Icons with the stored colour and icon marked.
  await page.getByRole("button", { name: "Change icon" }).click();
  await expect(picker(page).getByRole("tab", { name: "Icons" })).toHaveAttribute("aria-selected", "true");
  await expect(picker(page).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await expect(picker(page).getByRole("button", { name: "Rocket icon" })).toHaveAttribute("aria-pressed", "true");
});

test("mention chips, sub-page rows and the link menu draw another page's image icon", async ({ page }) => {
  await serveAttachments(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("notion-shell-meta")) return;
    sessionStorage.setItem("notion-shell-attachments", JSON.stringify({ a_0000uploadedfileABCDEF: "agenda" }));
    sessionStorage.setItem("notion-shell-meta", JSON.stringify({ agenda: { icon: "/api/attachments/a_0000uploadedfileABCDEF" } }));
  });
  await open(page);
  await page.evaluate(() => {
    (window as any).prismShell.serverEdit("field-notes", '<p>See <span data-type="mention" data-kind="page" data-id="agenda" data-mention-uid="m1"></span> first.</p><div data-type="child-page" data-page-id="agenda"></div><p>End</p>');
    (window as any).prismShellUI.getState().openTab("field-notes", "Field notes", "document");
  });
  const doc = page.locator("#workspace-document");
  await expect(doc.locator(".prism-mention-chip .prism-mention-icon img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await expect(doc.locator(".prism-child-page-icon img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await expect(doc.locator(".prism-mention-chip")).toContainText("Workshop agenda");
  await expect(doc.getByText("/api/attachments/", { exact: false })).toHaveCount(0);
  // `[[` suggestions.
  await doc.getByText("End").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Workshop ag");
  const option = page.getByRole("listbox", { name: "Link to a document" }).getByRole("option", { name: /Workshop agenda/ }).first();
  await expect(option.locator("[data-wikilink-icon] img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  await page.keyboard.press("Escape");
});

test("phone: the picker fits the screen and an uploaded icon shows in the page header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveAttachments(page);
  await open(page);
  await page.getByRole("button", { name: "Add icon" }).click();
  const box = (await picker(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  for (const name of ["Emoji", "Icons", "Upload"]) {
    const tab = (await picker(page).getByRole("tab", { name }).boundingBox())!;
    expect(tab.height).toBeGreaterThanOrEqual(30);
  }
  await picker(page).getByRole("tab", { name: "Upload" }).click();
  await picker(page).getByLabel("Icon image file").setInputFiles(FILE);
  await expect.poll(() => icon(page)).toBe(FIRST);
  await expect(page.locator(".document-icon-control.has-icon img.page-icon-img")).toHaveAttribute("data-icon-src", FIRST);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // A file that is not an image is refused before anything is sent.
  await page.getByRole("button", { name: "Change icon" }).click();
  const before = await page.evaluate(() => (window as any).prismShell.uploads.length);
  await picker(page).getByLabel("Icon image file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(picker(page).getByRole("alert")).toContainText("PNG, JPEG, GIF, WebP or AVIF");
  expect(await page.evaluate(() => (window as any).prismShell.uploads.length)).toBe(before);
});
