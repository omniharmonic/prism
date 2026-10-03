import { test, expect } from "@playwright/test";
import { zipSync } from "../../../packages/core/src/lib/import-export/zip";
import { fixtureNotes, runCommand, shot, transferRequests, transferUrl, serveAttachments } from "./transfer-helpers";

/** NP-TX-05 — import a Notion export: dry-run summary first, then nesting, images, wikilinks and a database. */
const nav = (page: import("@playwright/test").Page) => page.locator(".workspace-navigation").first();
test.beforeEach(async ({ page }) => { await serveAttachments(page); });
const tree = (page: import("@playwright/test").Page) => nav(page).getByRole("region", { name: "Pages", exact: true });
const ID = (n: number) => String(n).padStart(32, "0");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function notionExport(): Buffer {
  return Buffer.from(zipSync([
    { name: `Field notes ${ID(1)}.md`, data: `# Field notes\n\nStart with the [Plan](Field%20notes%20${ID(1)}/Plan%20${ID(2)}.md), then the [Reading list](Field%20notes%20${ID(1)}/Reading%20list%20${ID(3)}.csv).\n\n![River](Field%20notes%20${ID(1)}/river.png)\n` },
    { name: `Field notes ${ID(1)}/Plan ${ID(2)}.md`, data: `# Plan\n\nBack to [Field notes](../Field%20notes%20${ID(1)}.md).\n` },
    { name: `Field notes ${ID(1)}/river.png`, data: PNG },
    { name: `Field notes ${ID(1)}/Reading list ${ID(3)}.csv`, data: "Name,Status,Pages\nDune,Done,412\nEmma,Reading,474\n" },
    { name: `Field notes ${ID(1)}/Reading list ${ID(3)}/Dune ${ID(4)}.md`, data: "# Dune\n\nStatus: Done\nPages: 412\n\nA desert planet.\n" },
  ]));
}

test("notion zip dry run then import", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(transferUrl());
  await expect(tree(page)).toBeVisible();
  const before = (await fixtureNotes(page)).length;
  await runCommand(page, "Import… (Markdown, HTML, CSV, Notion)");
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Preview import" })).toBeDisabled();
  await shot(page, "import-pick-1440");
  await dialog.getByLabel("File to import").setInputFiles({ name: "Export-0b3c9f1e-4a2d-4c7b-9e11-5d2f8a6b7c90.zip", mimeType: "application/zip", buffer: notionExport() });
  // A destination folder is proposed (Notion's `Export-<uuid>` is not kept as a name) and can be changed.
  await expect(dialog.getByLabel("Import into")).toHaveValue("vault/Imports/Notion export");
  await dialog.getByLabel("Import into").fill("vault/Imports/Notion");
  await dialog.getByRole("button", { name: "Preview import" }).click();

  // 1. The dry-run summary — and nothing has been written.
  const preview = dialog.getByTestId("import-preview");
  await expect(preview).toContainText("Nothing has been imported yet.");
  await expect(preview.getByLabel("What this file contains")).toContainText("2 pages");
  await expect(preview.getByLabel("What this file contains")).toContainText("1 database · 2 rows");
  await expect(preview.getByLabel("What this file contains")).toContainText("1 image or file");
  await expect(preview.getByLabel("What this file contains")).toContainText("3 links between pages");
  const rows = preview.getByRole("listitem");
  await expect(rows).toHaveText([/^Field notes\s+New$/, /^Plan\s+New$/, /^Reading list · Database\s+New$/, /^Dune · Row\s+New$/, /^Emma · Row\s+New$/]);
  await shot(page, "import-preview-1440");
  expect((await fixtureNotes(page)).length).toBe(before);
  expect((await transferRequests(page)).map((r) => r.import?.dryRun)).toEqual([true]);

  // 2. Confirm.
  await dialog.getByRole("button", { name: "Import 5 pages" }).click();
  await expect(dialog.getByRole("heading", { name: "Import finished" })).toBeVisible();
  await expect(dialog).toContainText("5 pages added, 1 file attached.");
  await shot(page, "import-done-1440");
  expect((await transferRequests(page)).at(-1)!.import).toMatchObject({ dryRun: false, parent: "vault/Imports/Notion" });

  const notes = await fixtureNotes(page);
  const at = (path: string) => notes.find((n) => n.path === path)!;
  // Nesting is preserved and Notion's ids are gone from every name.
  expect(notes.slice(before).map((n) => n.path)).toEqual([
    "vault/Imports/Notion/Field notes",
    "vault/Imports/Notion/Field notes/Plan",
    "vault/Imports/Notion/Field notes/Reading list",
    "vault/Imports/Notion/Field notes/Reading list/Dune",
    "vault/Imports/Notion/Field notes/Reading list/Emma",
  ]);
  // Internal links are wikilinks to the new pages; the image is an attachment of the page.
  const home = at("vault/Imports/Notion/Field notes");
  expect(home.content).toMatch(/^Start with the \[\[vault\/Imports\/Notion\/Field notes\/Plan\]\], then the \[\[vault\/Imports\/Notion\/Field notes\/Reading list\]\]\.\n\n!\[River\]\(\/api\/attachments\/a_[\w-]{22}\)\n$/);
  expect(at("vault/Imports/Notion/Field notes/Plan").content).toBe("Back to [[vault/Imports/Notion/Field notes]].\n");
  const stored = await page.evaluate(() => [...(window as any).prismTransfer.attachments.values()].map((a: any) => [a.name, a.mime, a.bytes.length]));
  expect(stored).toContainEqual(["river.png", "image/png", PNG.length]);
  // The CSV became a database whose rows are the pages, with the CSV's columns as properties.
  const db = at("vault/Imports/Notion/Field notes/Reading list");
  const tag = db.metadata.prism_database.source.tags[0];
  expect(db.metadata).toMatchObject({ prism_type: "database", prism_database: { version: 1, views: [{ type: "table", visible: ["status", "pages"] }] } });
  expect(at("vault/Imports/Notion/Field notes/Reading list/Dune")).toMatchObject({ tags: [tag], content: "A desert planet.\n", metadata: { title: "Dune", status: "Done", pages: "412" } });
  expect(at("vault/Imports/Notion/Field notes/Reading list/Emma")).toMatchObject({ tags: [tag], metadata: { title: "Emma", status: "Reading", pages: "474" } });

  // 3. The pages are in the workspace: the tree shows them and the first one opens.
  await dialog.getByRole("button", { name: "Open the first page" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Rename Field notes", exact: true })).toBeVisible();
  await expect(tree(page).getByRole("button", { name: "Field notes", exact: true })).toBeVisible();
  await expect(page.locator(".tiptap")).toContainText("Start with the");

  // 4. Running the same file again changes nothing.
  await runCommand(page, "Import… (Markdown, HTML, CSV, Notion)");
  await dialog.getByLabel("File to import").setInputFiles({ name: "Export-0b3c9f1e-4a2d-4c7b-9e11-5d2f8a6b7c90.zip", mimeType: "application/zip", buffer: notionExport() });
  await dialog.getByLabel("Import into").fill("vault/Imports/Notion");
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByTestId("import-preview")).toContainText("5 pages already imported and unchanged.");
  await expect(dialog.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  expect((await fixtureNotes(page)).length).toBe(before + 5);
});

test("a single Markdown file imports as one page; a damaged archive is refused with a plain message", async ({ page }) => {
  await page.goto(transferUrl());
  await runCommand(page, "Import… (Markdown, HTML, CSV, Notion)");
  const dialog = page.getByRole("dialog", { name: "Import" });
  await dialog.getByLabel("File to import").setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: notionExport().subarray(0, 200) });
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That file isn’t a zip archive.");
  await dialog.getByLabel("File to import").setInputFiles({ name: "Meeting notes.md", mimeType: "text/markdown", buffer: Buffer.from('---\ntags: ["notes", "agent-skill"]\nstatus: "draft"\n---\n\n# Meeting notes\n\nAgenda.\n') });
  await expect(dialog.getByLabel("Import into")).toHaveValue("vault/Imports");
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByTestId("import-preview").getByRole("listitem")).toHaveText([/^Meeting notes\s+New$/]);
  await dialog.getByText("1 note about this file").click();
  await expect(dialog).toContainText("tag not applied: agent-skill");
  await dialog.getByRole("button", { name: "Import 1 page" }).click();
  await expect(dialog.getByRole("heading", { name: "Import finished" })).toBeVisible();
  const note = (await fixtureNotes(page)).find((n) => n.path === "vault/Imports/Meeting notes")!;
  expect(note).toMatchObject({ content: "Agenda.\n", tags: ["notes"], metadata: { status: "draft" } });
});

test("importing into a shared page says who will see the pages and defaults to private", async ({ page }) => {
  await page.goto(transferUrl());
  await runCommand(page, "Import… (Markdown, HTML, CSV, Notion)");
  const dialog = page.getByRole("dialog", { name: "Import" });
  const file = { name: "Plans.md", mimeType: "text/markdown", buffer: Buffer.from("Quarter plans.\n") };
  await dialog.getByLabel("File to import").setInputFiles(file);
  // An ordinary folder: visible like any other page, no extra step.
  await dialog.getByRole("button", { name: "Preview import" }).click();
  const who = dialog.getByRole("group", { name: "Who can see the imported pages" });
  await expect(who.getByRole("radio", { name: /Workspace members/ })).toBeChecked();
  await expect(who).toContainText("Anyone in this workspace can open them");
  // Inside a page that is shared with other people: said plainly, and private by default.
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByLabel("Import into").fill("vault/Archive/Inbox");
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(who).toContainText("This folder is inside a shared page: 2 people will be able to open every imported page");
  await expect(who.getByRole("radio", { name: /Only me/ })).toBeChecked();
  await shot(page, "import-shared-1440");
  await dialog.getByRole("button", { name: "Import 1 page" }).click();
  await expect(dialog.getByRole("heading", { name: "Import finished" })).toBeVisible();
  expect((await transferRequests(page)).at(-1)!.import).toMatchObject({ dryRun: false, private: true, confirmShared: false });
  expect((await fixtureNotes(page)).find((n) => n.path === "vault/Archive/Inbox/Plans")!.metadata).toMatchObject({ prism_visibility: "private" });
  // Choosing to share is an explicit act, sent as an explicit confirmation.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await runCommand(page, "Import… (Markdown, HTML, CSV, Notion)");
  await dialog.getByLabel("File to import").setInputFiles({ ...file, name: "Shared plans.md" });
  await dialog.getByLabel("Import into").fill("vault/Archive/Inbox");
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await who.getByRole("radio", { name: /Everyone this folder is shared with/ }).check();
  await dialog.getByRole("button", { name: "Import 1 page" }).click();
  await expect(dialog.getByRole("heading", { name: "Import finished" })).toBeVisible();
  expect((await transferRequests(page)).at(-1)!.import).toMatchObject({ dryRun: false, private: false, confirmShared: true });
});

test("phone: the import dialog is a full-height sheet with reachable controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(transferUrl());
  // (On a phone the command palette is reached from the bottom bar; open the dialog directly.)
  await page.waitForFunction(() => !!(window as any).prismTransfer);
  await page.evaluate(() => (window as any).prismTransfer.ui.getState().openImport({}));
  const dialog = page.getByRole("dialog", { name: "Import" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("File to import").setInputFiles({ name: "Notes.zip", mimeType: "application/zip", buffer: notionExport() });
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByRole("button", { name: "Import 5 pages" })).toBeVisible();
  const box = (await dialog.getByRole("button", { name: "Import 5 pages" }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await shot(page, "import-preview-390");
});
