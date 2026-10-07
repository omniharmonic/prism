import { test, expect } from "@playwright/test";
import { runCommand, shot, transferRequests, transferUrl, unzip, serveAttachments } from "./transfer-helpers";

/** NP-TX-04 (whole-workspace ZIP) and NP-TX-06 (print). */
const nav = (page: import("@playwright/test").Page) => page.locator(".workspace-navigation").first();
test.beforeEach(async ({ page }) => { await serveAttachments(page); });

test("vault zip export", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(transferUrl());
  await runCommand(page, "Export workspace…");
  const dialog = page.getByRole("dialog", { name: "Export workspace" });
  await expect(dialog).toBeVisible();
  // Markdown or HTML (PDF is a single page's print, not a workspace export).
  await expect(dialog.getByRole("radio")).toHaveText(["Markdown", "HTML"]);
  await expect(dialog.getByRole("radio", { name: "Markdown" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("checkbox", { name: /Images and files/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Sub-pages/ })).toHaveCount(0);
  await shot(page, "export-workspace-1440");

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  // The owner sees progress while the archive is built.
  const bar = dialog.getByRole("progressbar");
  await expect(bar).toBeVisible();
  await expect(dialog.getByRole("status").first()).toContainText(/Exporting \d+ of 12 pages…|Preparing…/);
  const file = await download;
  expect(file.suggestedFilename()).toBe("Personal vault-export-2026-10-01.zip");
  await expect(dialog.getByRole("heading", { name: "Export ready" })).toBeVisible();
  await expect(dialog).toContainText("12 pages and 1 file in Personal vault-export-2026-10-01.zip");
  await shot(page, "export-ready-1440");

  const { files, sizes } = await unzip(file);
  // The tree is preserved as folders; a page with sub-pages is `Page.md` + `Page/`.
  for (const name of ["vault/Projects/Prism.md", "vault/Projects/Prism/Plan.md", "vault/Projects/Prism/Plan/Week 1.md", "vault/Archive.md", "vault/Journal/Weekly review.md", "_templates/Daily log.md", "_export.json"]) expect([...files.keys()]).toContain(name);
  // Properties as front matter; identity and system keys never leave.
  const prism = files.get("vault/Projects/Prism.md")!;
  expect(prism.startsWith('---\ntitle: "Prism"\ntags: ["page"]\ntype: "document"\nstatus: "active"\n---\n\n# Prism\n')).toBe(true);
  expect(prism).not.toContain("prism_creator");
  expect(prism).not.toContain("owner@example.test");
  // The attachment is in the archive and the page links to it relatively.
  const image = [...files.keys()].find((n) => n.startsWith("_attachments/"))!;
  expect(image).toMatch(/^_attachments\/Team photo-[\w-]{8}\.png$/);
  expect(sizes.get(image)).toBeGreaterThan(60);
  expect(prism).toContain(`src="../../${image.replace(" ", "%20")}"`);
  expect(prism).not.toContain("/api/attachments/");
  expect((await transferRequests(page)).find((r) => r.export)!.export).toEqual({ scope: "vault", format: "markdown", subpages: true, attachments: true });

  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("workspace import and export are the owner's and admins': a member is not offered them", async ({ page }) => {
  await page.goto(transferUrl("?member"));
  await expect(nav(page).getByRole("region", { name: "Pages", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill("Export");
  await expect(search.getByRole("option", { name: "Export page…" })).toBeVisible();
  await expect(search.getByRole("option", { name: "Export workspace…" })).toHaveCount(0);
  await search.getByRole("combobox").fill("Import");
  await expect(search.getByRole("option", { name: /^Import…/ })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`print stylesheet hides chrome (${theme} theme)`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => { (window as any).printCalls = 0; window.print = () => { (window as any).printCalls++; }; });
    await page.goto(transferUrl(theme === "dark" ? "?open=prism&dark" : "?open=prism"));
    await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
    const chrome = [nav(page), page.getByLabel("Open document tabs"), page.getByRole("button", { name: "Page actions", exact: true }), page.locator(".document-formatting-bar").first(), page.getByRole("button", { name: "Add property" }), page.getByRole("button", { name: "Add tag" }), page.getByRole("button", { name: "Add cover" })];
    for (const c of chrome) await expect(c).toBeVisible();

    await page.emulateMedia({ media: "print" });
    for (const c of chrome) await expect(c).toBeHidden();
    // The page itself — title, text, image — is all that is left.
    await expect(page.getByRole("heading", { name: "Rename Prism", exact: true })).toBeVisible();
    await expect(page.locator(".tiptap")).toContainText("The Prism project page.");
    await expect(page.locator(".tiptap img")).toBeVisible();
    const look = await page.evaluate(() => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const text = getComputedStyle(document.querySelector(".tiptap p")!);
      const doc = document.getElementById("workspace-document")!;
      const backgrounds: number[][] = [];
      for (let el: HTMLElement | null = document.querySelector(".tiptap p"); el; el = el.parentElement) {
        const bg = rgb(getComputedStyle(el).backgroundColor);
        if (bg.length < 4 || bg[3]! > 0) backgrounds.push(bg);
      }
      return { ink: rgb(text.color), backgrounds, overflow: getComputedStyle(doc).overflowY, rootHeight: getComputedStyle(document.getElementById("root")!.firstElementChild!).height, docLeft: doc.getBoundingClientRect().left };
    });
    // Dark ink on white in BOTH themes; nothing is clipped to one screen; no sidebar gutter.
    expect(look.ink.slice(0, 3).every((v) => v < 90)).toBe(true);
    expect(look.backgrounds.length).toBeGreaterThan(0);
    for (const bg of look.backgrounds) expect(bg.slice(0, 3).every((v) => v > 240)).toBe(true);
    expect(look.overflow).toBe("visible");
    expect(look.docLeft).toBe(0);
    await shot(page, `print-${theme}`);

    // "Print" in the page menu hands over to the system print dialog.
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: "Page actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Print", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).printCalls)).toBe(1);
  });
}
