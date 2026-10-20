import { test, expect } from "@playwright/test";
import { vault, acl } from "./helpers";

/**
 * @live — needs the live Prism Server + Parachute vault.
 *
 * A capability/share link recipient (`?t=<token>`) is a viewer: main.tsx skips
 * `fetchMe`, keeps `isViewer=true`, and renders `<App skipOnboarding />`. So the
 * (Tauri-only) onboarding wizard must NOT appear — the app drops straight into
 * the Shell.
 *
 * Inverse (NOT asserted here): a genuine signed-in owner built with
 * VITE_WEB_OWNER_ONBOARDING=true is the only actor who sees the wizard. That path
 * needs an owner session + a special build flag, so it is out of scope for this
 * live spec.
 */
const TAG = "_e2eob";
const created: string[] = [];
let token = "";
let capId = "";
let noteId = "";

test.beforeAll(async () => {
  const n = await vault.createNote({ content: "# E2E Onboarding\n\nviewer-skip fixture", path: "_test/e2eob/e2e-ob.md" });
  created.push(n.id);
  await vault.addTags(n.id, [TAG]);
  noteId = n.id;
  const link = await acl.createLink(n.id, "view");
  token = link.token;
  capId = link.capId;
});

test.afterAll(async () => {
  if (capId && noteId) await acl.deleteLink(noteId, capId).catch(() => {});
  for (const id of created) await vault.deleteNote(id).catch(() => {});
});

test("@live capability viewer skips the onboarding wizard", async ({ page }) => {
  await page.goto(`/?t=${encodeURIComponent(token)}`);

  // App mounted (not a blank crash / login screen).
  await expect(page.locator("#root")).not.toBeEmpty();

  // The onboarding wizard's distinctive step-0 / step-1 surfaces are ABSENT.
  await expect(page.getByText("Let's connect your services so everything flows through one window.")).toHaveCount(0);
  await expect(page.getByText("Connect Parachute Vault")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Test Connection" })).toHaveCount(0);
});
