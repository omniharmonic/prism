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
  // Remove any path publication left by the path-publish test (slug-based).
  try {
    const pubs = await acl.publications();
    for (const p of pubs) {
      if (p.kind === "path" && p.pathPrefix === TAG) await acl.unpublishSlug(p.slug);
    }
  } catch { /* */ }
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

test("@live owner opens Network → Federate: node identity + all four sections render", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Network" }).click();
  await page.getByRole("button", { name: "Federate" }).click();

  // The node identity card + the four management sections render for the owner.
  await expect(page.getByText("This node", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Peers", { exact: true })).toBeVisible();
  await expect(page.getByText("Spaces", { exact: true })).toBeVisible();
  await expect(page.getByText("Inbox", { exact: true })).toBeVisible();
  // The pairing flow is reachable (invite/join).
  await expect(page.getByRole("button", { name: /Invite a peer/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /New space/i })).toBeVisible();
});

test("@live Federate: owner can toggle the federation transport on and back off from the UI", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Network" }).click();
  await page.getByRole("button", { name: "Federate" }).click();

  const toggle = page.getByRole("switch", { name: /Federation transport/i });
  await expect(toggle).toBeVisible({ timeout: 10_000 });

  // Capture the starting state so we leave the live node exactly as we found it.
  const startedOn = (await toggle.getAttribute("aria-checked")) === "true";

  // Flip it and assert the server-reported state changes (status reflects the runtime flag).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(!startedOn), { timeout: 10_000 });
  expect((await acl.federationStatus()).enabled).toBe(!startedOn);

  // Flip back — restore the original state.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(startedOn), { timeout: 10_000 });
  expect((await acl.federationStatus()).enabled).toBe(startedOn);
});

test("@live Publish: owner can publish a folder (path prefix) and see a live URL", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Network" }).click();
  await expect(page.getByRole("heading", { name: "Network" })).toBeVisible();

  await page.getByRole("button", { name: "Publish a collection" }).click();
  // Switch to the path/folder mode and publish the test notes' directory.
  await page.getByRole("button", { name: /By folder/i }).click();
  await page.getByPlaceholder("e.g. projects/commons").fill(TAG);
  await page.getByRole("button", { name: "Publish folder" }).click();

  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("input[readonly]").first()).toHaveValue(/\/p\//);

  // The server records a PATH publication for our prefix.
  const pubs = await acl.publications();
  expect(pubs.some((p) => p.kind === "path" && p.pathPrefix === TAG)).toBe(true);
});

test("@live side nav shows an Obsidian-style vault switcher that opens", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");

  const switcher = page.getByRole("button", { name: "Switch vault" });
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.click();
  // The popover lists the vaults + the create/link entry.
  await expect(page.getByText("Vaults", { exact: true })).toBeVisible();
  await expect(page.getByText(/Create or link a vault/i)).toBeVisible();
});

test("@live owner opens Network → Vaults: the configured vault is listed as active", async ({ context, page }) => {
  await authedContext(context);
  await page.goto("/");
  await page.getByRole("button", { name: "Network" }).click();
  await page.getByRole("button", { name: "Vaults" }).click();

  // The single configured vault (primary) renders and is marked Active.
  await expect(page.getByText("Connected vaults", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Connect another vault", { exact: true })).toBeVisible();
});
