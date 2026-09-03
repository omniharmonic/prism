/**
 * Commons governance — full e2e through the real browser UI (@live).
 *
 * Drives the exact flows a commons steward walks: owner signs in via magic
 * link, bootstraps the constitution (role → amend policy → membership), enables
 * & LOCKS it, then — now that even the owner can't edit directly — amends it
 * through a proposal (open → approve → apply) and runs a governed content
 * change end to end.
 *
 * Stack-agnostic: runs against any Prism Server at E2E_BASE_URL (real vault or
 * scripts/e2e/fake-vault.mjs). The magic link is read from the server's log
 * (E2E_SERVER_LOG) — the server prints it when RESEND_API_KEY is unset, which
 * is exactly the dev flow. Run via scripts/e2e-governance.sh.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE_URL, OWNER_TOKEN, OWNER_EMAIL } from "./helpers";

const SERVER_LOG = process.env.E2E_SERVER_LOG ?? "";
const GOV_TAGS = [
  "governance-config",
  "governance-role",
  "governance-membership",
  "governance-policy",
  "governance-proposal",
  "governance-vote",
  "governance-audit",
];

/** Owner-token vault access through the gateway (local Bearer → owner passthrough). */
async function ownerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json", ...(init?.headers as Record<string, string>) },
  });
}

/** Reset all governance state so each run starts from an unlocked vault. */
async function resetGovernanceNotes(): Promise<void> {
  for (const tag of GOV_TAGS) {
    const r = await ownerFetch(`/api/notes?tag=${encodeURIComponent(tag)}`);
    if (!r.ok) throw new Error(`reset: list ${tag} → ${r.status}`);
    const notes = (await r.json()) as Array<{ id: string }>;
    for (const n of notes) await ownerFetch(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
  }
}

/** Sign the page's browser context in as the owner via the magic-link flow:
 *  request a link over the API, read it from the server log, open it. */
async function loginAsOwner(page: Page): Promise<void> {
  if (!SERVER_LOG) throw new Error("E2E_SERVER_LOG not set — run via scripts/e2e-governance.sh");
  const before = readFileSync(SERVER_LOG, "utf8").length;
  const res = await page.request.post(`${BASE_URL}/auth/request`, { data: { email: OWNER_EMAIL } });
  expect(res.ok()).toBeTruthy();

  let link = "";
  await expect
    .poll(
      () => {
        const fresh = readFileSync(SERVER_LOG, "utf8").slice(before);
        const m = fresh.match(/http[^\s"]*auth\/callback\?token=[^\s"]*/g);
        link = m?.[m.length - 1] ?? "";
        return link;
      },
      { timeout: 10_000, message: "magic link should appear in the server log" },
    )
    .not.toBe("");

  // The link's origin is APP_ORIGIN; retarget it at the server under test.
  const url = new URL(link);
  await page.goto(`${BASE_URL}${url.pathname}${url.search}`);
  // Redeeming redirects to / or /set-password; either way the session is set.
  const me = await page.request.get(`${BASE_URL}/auth/me`);
  expect(((await me.json()) as { authenticated: boolean }).authenticated).toBe(true);
}

test.describe("commons governance @live", () => {
  test.beforeAll(async () => {
    await resetGovernanceNotes();
  });

  test("bootstrap → lock → self-amend → governed content change", async ({ page }) => {
    // One deliberately long journey (it IS the product's core loop) — give it
    // room beyond the default 30s per-test budget.
    test.setTimeout(120_000);
    await loginAsOwner(page);
    await page.goto("/governance");

    // ── fresh commons: unlocked, owner is the bootstrap root ──
    await expect(page.getByText("Not enabled")).toBeVisible();
    await expect(page.getByText("Unlocked (bootstrap)")).toBeVisible();
    await expect(page.getByText("You are the bootstrap owner")).toBeVisible();

    // ── bootstrap: admin role with the constitutional + publish powers ──
    await page.getByPlaceholder("name (e.g. gardener)").fill("admin");
    await page.getByRole("checkbox", { name: "amend_governance" }).check();
    await page.getByRole("checkbox", { name: "publish", exact: true }).check();
    await page.getByRole("button", { name: "Add role" }).click();
    await expect(page.locator("text=admin").first()).toBeVisible();

    // ── amend policy: 1 distinct admin (threshold kept small for the e2e) ──
    await page.getByPlaceholder("action (edit_note / new_entry / amend_governance)").fill("amend_governance");
    await page.getByPlaceholder("eligible role").fill("admin");
    await page.locator('input[type="number"]').first().fill("1");
    await page.getByRole("button", { name: "Add policy" }).click();
    await expect(page.getByText("amend_governance").first()).toBeVisible();

    // ── owner joins the admin role (so they can vote after the lock) ──
    await page.getByPlaceholder("subject email").fill(OWNER_EMAIL);
    await page.getByPlaceholder("role name").fill("admin");
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText(OWNER_EMAIL).first()).toBeVisible();

    // ── ENABLE & LOCK (one-way latch; confirm dialog) ──
    const amendSelect = page.locator("select");
    await amendSelect.selectOption({ index: 1 }); // the policy just created
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Enable & lock" }).click();

    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(page.getByText("Locked (self-amending)")).toBeVisible();
    // The bootstrap card is gone — there is no direct-edit path anymore.
    await expect(page.getByText("Bootstrap the constitution")).toHaveCount(0);

    // ── self-amend: add a gardener role via proposal → approve → apply ──
    await expect(page.getByText("New amendment proposal")).toBeVisible();
    await page.getByRole("button", { name: "add_role" }).click(); // template
    await page.getByRole("button", { name: "Open amendment proposal" }).click();
    await expect(page.getByText("amend_governance →").first()).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).first().click();
    await page.getByRole("button", { name: "Apply" }).first().click();

    // The amendment is live: the gardener role now shows in the Roles card.
    await expect(page.getByText("gardener").first()).toBeVisible();

    // ── governed content change with APPROVAL ≠ PUBLISHING ──
    // The default policy does not auto-publish, so Apply stages the entry; it
    // goes live only at the explicit Publish step.
    await page.getByRole("radio", { name: "new_entry" }).check();
    await page.getByPlaceholder("path (e.g. medicine/yarrow)").fill("medicine/e2e-yarrow");
    await page.getByPlaceholder("tags (comma-separated)").fill("medicine");
    await page.getByPlaceholder("proposed content (may be a stub)").fill("# Yarrow (e2e)\nA stub for a gardener to fill in.");
    await page.getByRole("button", { name: "Propose", exact: true }).click();
    await expect(page.getByText("new_entry →").first()).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).first().click();
    await page.getByRole("button", { name: "Apply" }).first().click();

    // Approved but NOT live: the staged section shows it, and the vault has no
    // medicine note yet.
    await expect(page.getByText("Approved — awaiting publish")).toBeVisible();
    {
      const r = await ownerFetch(`/api/notes?tag=medicine`);
      const notes = (await r.json()) as Array<{ content: string }>;
      expect(notes.some((n) => n.content.includes("Yarrow (e2e)"))).toBe(false);
    }

    // Publish → the note exists in the vault.
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect
      .poll(async () => {
        const r = await ownerFetch(`/api/notes?tag=medicine`);
        const notes = (await r.json()) as Array<{ content: string }>;
        return notes.some((n) => n.content.includes("Yarrow (e2e)"));
      })
      .toBe(true);

    // ── the audit trail recorded the journey ──
    await page.reload();
    await expect(page.getByText("Audit trail")).toBeVisible();
    await expect(page.getByText(/apply:new_entry|amend:add_role/).first()).toBeVisible();
  });

  test("a stranger cannot reach governance", async ({ page }) => {
    await page.goto("/governance");
    // No session → the login screen renders instead of the panel.
    await expect(page.getByText("Sign in to access commons governance.")).toBeVisible();
  });
});
