import { test, expect, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { vault, acl, BASE_URL } from "./helpers";

const SERVER_DIR = resolve(process.cwd(), "../server");
function mintOwnerSession(): string {
  return execSync("node --env-file=.env --import tsx scripts/mk-owner-session.ts", { cwd: SERVER_DIR, encoding: "utf8" }).trim();
}
async function authedContext(context: BrowserContext) {
  const sid = mintOwnerSession();
  const url = new URL(BASE_URL);
  await context.addCookies([
    { name: "prism_session", value: sid, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

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
const COMMENT_HEADING = "E2EPUB Comment Heading Marker";

test.beforeAll(async () => {
  const home = await vault.createNote({ content: `# E2E Publish Home\n\n${HOME_BODY}`, path: "_test/e2epub/e2e-pub-home.md" });
  created.push(home.id);
  await vault.addTags(home.id, [TAG]);
  homeId = home.id;

  const second = await vault.createNote({ content: "# E2E Publish Second\n\nsecond body", path: "_test/e2epub/e2e-pub-second.md" });
  created.push(second.id);
  await vault.addTags(second.id, [TAG]);

  // Markdown note that STARTS WITH an HTML comment (the bug: misclassified as
  // HTML → dumped raw, with `##` shown literally and newlines collapsed).
  const withComment = await vault.createNote({
    content: `<!-- Note: leading comment -->\n\n## ${COMMENT_HEADING}\n\nBody with **bold** text.`,
    path: "_test/e2epub/e2e-pub-comment.md",
  });
  created.push(withComment.id);
  await vault.addTags(withComment.id, [TAG]);

  slug = await acl.publishTag(TAG, { title: "E2E Pub Site", homeNoteId: homeId });
});

test.afterAll(async () => {
  await acl.unpublishTag(TAG).catch(() => {});
  for (const id of created) await vault.deleteNote(id).catch(() => {});
});

test("@live public wiki renders both in-set notes in the nav and the home body", async ({ page }) => {
  // Sanity: the anonymous manifest lists our three notes.
  const m = await (await fetch(`${BASE_URL}/api/p/${slug}`)).json();
  expect(m.notes).toHaveLength(3);

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

test("@live a markdown note starting with an HTML comment renders as markdown, not raw", async ({ page }) => {
  await page.goto(`/p/${slug}`);
  await page.locator("nav").first().getByText("e2e-pub-comment", { exact: false }).click();

  const article = page.locator("article.prose-editor");
  // `## …` became an <h2> (markdown parsed) and `**bold**` became <strong>…
  await expect(article.locator("h2")).toContainText(COMMENT_HEADING);
  await expect(article.locator("strong")).toContainText("bold");
  // …not dumped as literal markdown syntax.
  await expect(article).not.toContainText(`## ${COMMENT_HEADING}`);
});

test("@live owner can exclude a note from a publication via the Content controls", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Network" }).click();
  await expect(page.getByRole("heading", { name: "Network" })).toBeVisible();

  // Manifest starts with all three notes.
  const before = await (await fetch(`${BASE_URL}/api/p/${slug}`)).json();
  expect(before.notes).toHaveLength(3);

  // Open this publication's settings, then its Content list.
  const card = page.locator(`[data-pub-slug="${slug}"]`);
  await card.getByRole("button", { name: "Settings" }).click();
  await expect(card.getByText("Content", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Uncheck the "second" note (path basename e2e-pub-second → title "e2e-pub-second"),
  // then save. The Content list rows carry a checkbox per note.
  const row = card.locator("div", { hasText: "e2e-pub-second" }).filter({ has: page.locator('input[type="checkbox"]') }).last();
  await row.locator('input[type="checkbox"]').uncheck();
  await card.getByRole("button", { name: "Save content" }).click();

  // The public manifest now drops that note.
  await expect.poll(async () => (await (await fetch(`${BASE_URL}/api/p/${slug}`)).json()).notes.length, {
    timeout: 10_000,
  }).toBe(2);
});
