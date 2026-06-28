import { test, expect, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { vault, acl, BASE_URL } from "./helpers";

// Playwright runs from the @prism/web workspace dir → apps/server is a sibling.
const SERVER_DIR = resolve(process.cwd(), "../server");

/**
 * E2E for the Network surface (owner-only). Drives the real owner UI by injecting
 * a server-minted owner session cookie (no magic-link round-trip), then clicks
 * through the Network tab → Publish flow. @live — needs the running server+vault.
 */

function mintOwnerSession(): string {
  return execSync("node --env-file=.env --import tsx scripts/mk-owner-session.ts", {
    cwd: SERVER_DIR,
    encoding: "utf8",
  }).trim();
}

const TAG = "_e2enet";
const NOTE_IDS: string[] = [];

async function authedContext(context: BrowserContext) {
  const sid = mintOwnerSession();
  const url = new URL(BASE_URL);
  await context.addCookies([
    { name: "prism_session", value: sid, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test.beforeAll(async () => {
  // A small collection to publish.
  for (const [i, body] of [
    "# Net Alpha\n\nLinks to [[Net Beta]].",
    "# Net Beta\n\nBack to [[Net Alpha]].",
  ].entries()) {
    const n = await vault.createNote({ content: body, path: `${TAG}/n${i}.md`, tags: [TAG] });
    NOTE_IDS.push(n.id);
  }
});

test.afterAll(async () => {
  try { await acl.unpublishTag(TAG); } catch { /* */ }
  for (const id of NOTE_IDS) { try { await vault.deleteNote(id); } catch { /* */ } }
});

test("@live owner opens Network → Publish, publishes a collection, sees a live URL", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");

  // Land in the Shell (not login/onboarding) and open the Network surface.
  await page.getByRole("button", { name: "Network" }).click();
  await expect(page.getByRole("heading", { name: "Network" })).toBeVisible();

  // Publish tab is default; start a new publication and pick our tag.
  await page.getByRole("button", { name: "Publish a collection" }).click();
  const search = page.getByPlaceholder("Search tags…");
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.fill(TAG);
  await page.getByRole("button", { name: new RegExp(`#${TAG}\\b`) }).click();
  await page.getByRole("button", { name: `Publish #${TAG}` }).click();

  // The success state shows a "Live" badge + the public /p/ URL (in a readonly input).
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("input[readonly]").first()).toHaveValue(/\/p\//);

  // And the server agrees it's published.
  const pubs = await acl.publications();
  expect(pubs.some((p) => p.tag === TAG)).toBe(true);
});
