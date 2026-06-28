import { test, expect } from "@playwright/test";
import { vault, acl, pub } from "./helpers";

/**
 * @live — needs the live Prism Server + Parachute vault.
 *
 * Leak-proofing: an in-set note wikilinks BOTH another in-set note and an
 * out-of-set (private) note. Assert:
 *   1. the in-set wikilink is a real anchor and navigates (URL → /p/:slug/notes/:id);
 *   2. the out-of-set wikilink collapses to inert text (no anchor → no leak);
 *   3. GET /api/p/:slug/graph contains NO out-of-set node and NO edge touching it.
 */
const TAG = "_e2elink"; // in-publication
const OUT_TAG = "_e2elinkout"; // private, never published
const created: string[] = [];
let slug = "";
let homeId = "";
let siblingId = "";
let outId = "";

test.beforeAll(async () => {
  // Sibling (in-set), resolved by basename `e2e-sibling`.
  const sibling = await vault.createNote({ content: "# E2E Sibling\n\nin-set sibling body", path: "_test/e2elink/e2e-sibling.md" });
  created.push(sibling.id);
  await vault.addTags(sibling.id, [TAG]);
  siblingId = sibling.id;

  // Out-of-set (private), basename `e2e-private` — NOT in the publication.
  const outNote = await vault.createNote({ content: "# E2E Private\n\nMUST_NOT_LEAK private body", path: "_test/e2elink/e2e-private.md" });
  created.push(outNote.id);
  await vault.addTags(outNote.id, [OUT_TAG]);
  outId = outNote.id;

  // Home (in-set) links the in-set sibling AND the out-of-set private note.
  const home = await vault.createNote({
    content: "# E2E Link Home\n\nGo to [[e2e-sibling]] and to the [[e2e-private]] note.",
    path: "_test/e2elink/e2e-home.md",
  });
  created.push(home.id);
  await vault.addTags(home.id, [TAG]);
  homeId = home.id;

  slug = await acl.publishTag(TAG, { title: "E2E Link Site", homeNoteId: homeId });
});

test.afterAll(async () => {
  await acl.unpublishTag(TAG).catch(() => {});
  for (const id of created) await vault.deleteNote(id).catch(() => {});
});

test("@live in-set wikilink navigates; out-of-set wikilink is inert", async ({ page }) => {
  await page.goto(`/p/${slug}`);
  const article = page.locator("article.prose-editor");
  await expect(article).toBeVisible();

  // Exactly one resolved wikilink anchor — to the in-set sibling.
  const links = article.locator("a.pub-wikilink");
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute("data-target", siblingId);

  // The out-of-set target rendered as inert text (no anchor for it).
  await expect(article.getByText("e2e-private", { exact: false })).toBeVisible();
  await expect(article.locator(`a.pub-wikilink[data-target="${outId}"]`)).toHaveCount(0);

  // Clicking the in-set wikilink navigates within the publication.
  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${slug}/notes/${siblingId}$`));
  await expect(article).toContainText("in-set sibling body");
});

test("@live publication graph drops the out-of-set node and edge", async () => {
  const g = await pub.graph(slug);
  expect(g.status).toBe(200);
  const nodeIds: string[] = (g.body.nodes ?? []).map((n: any) => n.id);
  const edges: Array<{ source: string; target: string }> = g.body.edges ?? [];

  // In-set nodes present; the private node absent.
  expect(nodeIds).toContain(homeId);
  expect(nodeIds).toContain(siblingId);
  expect(nodeIds).not.toContain(outId);

  // The in-set → in-set edge is present; no edge references the private note.
  expect(edges.some((e) => e.source === homeId && e.target === siblingId)).toBe(true);
  expect(edges.some((e) => e.source === outId || e.target === outId)).toBe(false);

  // And the private note's body is never reachable through the public surface.
  const blocked = await pub.note(slug, outId);
  expect(blocked.status).toBe(403);
});
