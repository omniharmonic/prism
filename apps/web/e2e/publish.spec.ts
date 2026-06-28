import { test, expect } from "@playwright/test";
import { vault, acl, BASE_URL } from "./helpers";

/**
 * @live — needs the live Prism Server + Parachute vault.
 *
 * Publish a tag carrying two throwaway notes, then assert the public wiki at
 * /p/:slug renders BOTH in-set notes in the nav and the home note's body. Setup
 * goes through the trusted API seams (vault REST + owner /acl); the browser only
 * ever sees the anonymous public surface. Teardown unpublishes + deletes.
 */
const TAG = "_e2epub";
const created: string[] = [];
let slug = "";
let homeId = "";

const HOME_BODY = "E2EPUB_HOME_BODY_MARKER_42";

test.beforeAll(async () => {
  const home = await vault.createNote({ content: `# E2E Publish Home\n\n${HOME_BODY}`, path: "_test/e2epub/e2e-pub-home.md" });
  created.push(home.id);
  await vault.addTags(home.id, [TAG]);
  homeId = home.id;

  const second = await vault.createNote({ content: "# E2E Publish Second\n\nsecond body", path: "_test/e2epub/e2e-pub-second.md" });
  created.push(second.id);
  await vault.addTags(second.id, [TAG]);

  slug = await acl.publishTag(TAG, { title: "E2E Pub Site", homeNoteId: homeId });
});

test.afterAll(async () => {
  await acl.unpublishTag(TAG).catch(() => {});
  for (const id of created) await vault.deleteNote(id).catch(() => {});
});

test("@live public wiki renders both in-set notes in the nav and the home body", async ({ page }) => {
  // Sanity: the anonymous manifest lists exactly our two notes.
  const m = await (await fetch(`${BASE_URL}/api/p/${slug}`)).json();
  expect(m.notes).toHaveLength(2);

  await page.goto(`/p/${slug}`);

  // The home note's body renders in the article.
  await expect(page.locator("article.prose-editor")).toContainText(HOME_BODY);

  // Both in-set notes appear in the left nav: the home pinned at top, the sibling
  // as a leaf under its (default-open) folder. The manifest is fetched WITHOUT
  // content, so nav labels derive from the path basename (not the content
  // heading): home title → "e2e pub home", sibling leaf → "e2e-pub-second".
  const nav = page.locator("nav").first();
  await expect(nav.getByText("e2e pub home", { exact: false })).toBeVisible();
  await expect(nav.getByText("e2e-pub-second", { exact: false })).toBeVisible();
});
