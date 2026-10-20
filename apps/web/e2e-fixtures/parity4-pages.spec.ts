import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Slice M review (S7) · the tree's Rename and names a path cannot hold: the typed name is kept
 * as the page's stored title, and a rename that changes ONLY the title (the file name already
 * says it as far as a path can) writes the title without a move.
 * Fixture: pages-nav.html (the workspace over an in-page fake of the server).
 */
const url = (q = "") => `/e2e-fixtures/pages-nav.html${q}`;
const nav = (page: Page) => page.locator(".workspace-navigation").first();
const note = (page: Page, id: string) => page.evaluate((i) => { const n = (window as any).prismFixtureNotes.find((x: any) => x.id === i); return { path: n?.path as string, title: n?.metadata?.title as string | undefined }; }, id);
const moves = (page: Page) => page.evaluate(() => ((window as any).prismFixtureWrites as Array<Record<string, unknown>>).filter((w) => "move" in w || typeof w.path === "string" || typeof w.newPath === "string").length);

async function renameInTree(page: Page, from: string, to: string) {
  await nav(page).getByRole("button", { name: `Page actions for ${from}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const field = nav(page).getByRole("textbox", { name: `Rename ${from}`, exact: true });
  await field.fill(to);
  await field.press("Enter");
}

test("the tree's Rename keeps a typed name the path cannot hold, and a title-only change needs no move", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url());
  await expect(nav(page).getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  const before = (await note(page, "plan")).path;
  // A name with a slash: the file gets a dash, the typed name is stored as the title.
  await renameInTree(page, "Plan", "Plan/2026");
  await expect.poll(async () => (await note(page, "plan")).path).toBe(before.replace(/Plan$/, "Plan-2026"));
  await expect.poll(async () => (await note(page, "plan")).title).toBe("Plan/2026");
  const after = await moves(page);
  // Now a name that differs from the stored title only where a path cannot say it: a backslash
  // becomes a dash too, so the file name is the same — only the stored title changes, no move.
  const shown = (await nav(page).getByRole("button", { name: "Page actions for Plan/2026", exact: true }).count()) ? "Plan/2026" : "Plan-2026";
  await renameInTree(page, shown, "Plan\\2026");
  await expect.poll(async () => (await note(page, "plan")).title).toBe("Plan\\2026");
  expect((await note(page, "plan")).path).toBe(before.replace(/Plan$/, "Plan-2026"));
  expect(await moves(page)).toBe(after);
});

// Review of PR #42, finding 3: the container-page guard is repeated on the path the server has NOW.
// The real `renamePageFromTitle` (loaded as the page loads it) over a recording client: the caller
// still holds the page's OLD path, the server already has it at `<folder>/PROJECT`.
const TITLE_RENAME_MODULE = `/@fs${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/core/src/lib/pages/titleRename.ts")}`;
for (const leaf of ["PROJECT", "README.md", "index"]) {
  test(`a title edit with a stale path never moves a container-named file (${leaf}): the title is stored`, async ({ page }) => {
    await page.goto(url());
    await expect(nav(page).getByRole("button", { name: "Plan", exact: true })).toBeVisible();
    const out = await page.evaluate(async ([file, moduleUrl]) => {
      const { renamePageFromTitle } = await import(/* @vite-ignore */ moduleUrl!);
      const calls: Array<[string, unknown]> = [];
      const now = `vault/projects/food-chain/${file}`;
      const client = {
        getNote: async () => ({ id: "n1", path: now, content: "", metadata: {}, updatedAt: "2026-01-01T00:00:00.000Z" }),
        updateNote: async (_id: string, patch: unknown) => { calls.push(["updateNote", patch]); return {}; },
        movePage: async (_id: string, request: unknown) => { calls.push(["movePage", request]); return { ok: true, path: "moved", moved: [] }; },
        updateProperties: async (_id: string, set: unknown) => { calls.push(["updateProperties", set]); return {}; },
      };
      const result = await renamePageFromTitle(client, { id: "n1", path: "vault/projects/food-chain/Overview" }, "Bioregional Food Chain");
      return { calls, result };
    }, [leaf, TITLE_RENAME_MODULE]);
    expect(out.calls).toEqual([["updateNote", { metadata: { title: "Bioregional Food Chain" } }]]);
    expect(out.result).toEqual({ path: `vault/projects/food-chain/${leaf}`, partial: false, title: "Bioregional Food Chain" });
  });
}
