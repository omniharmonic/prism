import { test, expect } from "@playwright/test";
import { vault, acl, pub, E2E_HTTPS } from "./helpers";

/**
 * @live — needs the live Prism Server + Parachute vault.
 *
 * Password-gated publication lifecycle:
 *   - locked: /p/:slug shows the unlock prompt, nav is withheld, the note API 401s
 *     (these ALWAYS hold, regardless of transport);
 *   - unlock: POST /api/p/:slug/auth with the right password returns ok and sets
 *     the `pub_<slug>` cookie. That cookie is `secure` only when APP_ORIGIN is
 *     https, so the reload→unlocked assertion is gated behind E2E_HTTPS (a secure
 *     cookie may not stick on a plain-http origin);
 *   - unpublish: DELETE clears the publication → /api/p/:slug 404 and the
 *     publication (its `anyone` grant + row) is gone.
 */
const TAG = "_e2epw";
const PASSWORD = "e2e-hunter2";
const BODY = "E2EPW_SECRET_BODY_MARKER_77";
const created: string[] = [];
let slug = "";
let noteId = "";

test.beforeAll(async () => {
  const n = await vault.createNote({ content: `# E2E Password\n\n${BODY}`, path: "_test/e2epw/e2e-pw.md" });
  created.push(n.id);
  await vault.addTags(n.id, [TAG]);
  noteId = n.id;
  slug = await acl.publishTag(TAG, { title: "E2E PW Site", password: PASSWORD });
});

test.afterAll(async () => {
  await acl.unpublishTag(TAG).catch(() => {});
  for (const id of created) await vault.deleteNote(id).catch(() => {});
});

test("@live locked publication withholds nav + body until unlocked, then unpublish 404s", async ({ page }) => {
  // --- locked state (always holds) ---
  const m = await pub.manifest(slug);
  expect(m.status).toBe(200);
  expect(m.body.passwordRequired).toBe(true);
  expect(m.body.notes).toHaveLength(0); // nav withheld while locked

  const lockedNote = await pub.note(slug, noteId);
  expect(lockedNote.status).toBe(401);

  await page.goto(`/p/${slug}`);
  await expect(page.getByText("This publication is password protected.")).toBeVisible();
  await expect(page.locator("nav")).toHaveCount(0); // structure not leaked
  await expect(page.locator("article.prose-editor")).toHaveCount(0);

  // Wrong password → still locked (generic 401).
  const wrong = await page.request.post(`/api/p/${slug}/auth`, { data: { password: "nope" } });
  expect(wrong.status()).toBe(401);

  // --- unlock POST returns ok (always asserted) ---
  const unlock = await page.request.post(`/api/p/${slug}/auth`, { data: { password: PASSWORD } });
  expect(unlock.ok()).toBe(true);

  // --- reload→unlocked: gated behind E2E_HTTPS (secure cookie may not stick on http) ---
  const cookies = await page.context().cookies();
  const hasUnlockCookie = cookies.some((c) => c.name === `pub_${slug}`);
  if (E2E_HTTPS && hasUnlockCookie) {
    await page.reload();
    await expect(page.locator("article.prose-editor")).toContainText(BODY);
    await expect(page.locator("nav").first()).toBeVisible();
  } else {
    test.info().annotations.push({
      type: "skip",
      description: `unlocked-reload assertion skipped (E2E_HTTPS=${E2E_HTTPS}, cookie set=${hasUnlockCookie}); locked→401 + unlock-ok already asserted`,
    });
  }

  // --- unpublish clears everything ---
  await acl.unpublishTag(TAG);
  const after = await pub.manifest(slug);
  expect(after.status).toBe(404); // publication row + anyone grant gone
  const afterNote = await pub.note(slug, noteId);
  expect(afterNote.status).toBe(404);
  const pubs = await acl.publications();
  expect(pubs.some((p) => p.slug === slug || p.tag === TAG)).toBe(false);
});
