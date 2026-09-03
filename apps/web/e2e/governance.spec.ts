/**
 * Commons governance — full e2e through the real browser UI (@live).
 *
 * Drives the exact flows a commons steward walks: owner signs in via magic link,
 * runs the bootstrap wizard (template → adjust → ratify), LOCKS the constitution,
 * then — now that even the owner can't edit directly — amends it through a
 * proposal (open → approve → apply) and runs a governed content change end to end.
 *
 * The P3 surface is the product one, so the spec also asserts the two things that
 * make it a product rather than a form: a rule reads as a SENTENCE, and a proposal
 * shows its arithmetic ("1 of 1 approvals") before anyone can apply it.
 *
 * Stack-agnostic: runs against any Prism Server at E2E_BASE_URL (real vault or
 * scripts/e2e/fake-vault.mjs). The magic link is read from the server's log
 * (E2E_SERVER_LOG) — the server prints it when RESEND_API_KEY is unset, which is
 * exactly the dev flow. Run via scripts/e2e-governance.sh.
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
  "governance-revision",
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
    test.setTimeout(180_000);
    await loginAsOwner(page);
    await page.goto("/governance");

    // ── fresh commons: unlocked, owner is the bootstrap root ──
    await expect(page.getByTestId("gov-status-enabled")).toContainText("Draft");
    await expect(page.getByTestId("gov-status-lock")).toContainText("Unlocked");
    await expect(page.getByTestId("gov-status-bootstrap")).toBeVisible();
    await expect(page.getByTestId("gov-wizard")).toBeVisible();

    // ── step 1: start from the solo-curator template ──
    await page.getByTestId("gov-template-solo").click();
    await expect(page.getByTestId("gov-wizard-step2")).toBeVisible();
    // The template pre-filled a real role, editable in place.
    await expect(page.getByTestId("gov-wizard-role-0-name")).toHaveValue("steward");
    // ...and its rule already reads as a sentence in the builder.
    await expect(page.getByTestId("gov-wizard-policy-0-sentence")).toContainText(
      "Amendments to the constitution need 1 approval from Stewards",
    );

    // ── step 2 → save the draft (roles + rules + roster are written, not ratified) ──
    await page.getByTestId("gov-wizard-save").click();
    await expect(page.getByTestId("gov-wizard-step3")).toBeVisible();

    // The constitution now shows up as prose in the panel itself.
    await expect(page.getByTestId("gov-role-sentence").first()).toContainText("Stewards can read");
    await expect(page.getByTestId("gov-policy-sentence").first()).toContainText(
      "Amendments to the constitution need 1 approval from Stewards",
    );

    // ── step 3: every readiness check green, then the one-way latch ──
    const checks = page.getByTestId("gov-ratify-check");
    await expect(checks).toHaveCount(4);
    await page.getByTestId("gov-ratify-understood").check();
    await page.getByTestId("gov-ratify").click();

    await expect(page.getByTestId("gov-status-enabled")).toContainText("In force");
    await expect(page.getByTestId("gov-status-lock")).toContainText("Locked");
    // The wizard is gone — there is no direct-edit path anymore.
    await expect(page.getByTestId("gov-wizard")).toHaveCount(0);

    // ── self-amend: add a gardener role via proposal → approve → apply ──
    await expect(page.getByTestId("gov-amend-composer")).toBeVisible();
    await page.getByTestId("gov-amend-kind").selectOption("add_role");
    await page.getByTestId("gov-amend-role-name").fill("gardener");
    await page.getByTestId("gov-amend-open").click();

    const proposal = page.getByTestId("gov-proposal-card").first();
    await expect(proposal.getByTestId("gov-proposal-title")).toContainText("Create the gardener role");
    // Before anyone signs off, the card states the arithmetic.
    await expect(proposal.getByTestId("gov-proposal-progress")).toContainText("0 of 1 approvals");

    await proposal.getByTestId("gov-approve").click();
    await expect(page.getByTestId("gov-proposal-card").first().getByTestId("gov-proposal-progress")).toContainText(
      "1 of 1 approvals",
    );
    await page.getByTestId("gov-proposal-card").first().getByTestId("gov-apply").click();

    // The amendment is live: the gardener role now shows in the Roles section.
    await expect(page.getByTestId("gov-role-name").filter({ hasText: "gardener" })).toBeVisible();

    // ── governed content change with APPROVAL ≠ PUBLISHING ──
    // No rule auto-publishes new entries here, so Apply STAGES the entry; it goes
    // live only at the explicit Publish step.
    await page.getByRole("radio", { name: "add a new entry" }).check();
    await page.getByTestId("gov-propose-path").fill("medicine/e2e-yarrow");
    await page.getByTestId("gov-propose-tags").fill("medicine");
    await page.getByTestId("gov-propose-content").fill("# Yarrow (e2e)\nA stub for a gardener to fill in.");
    await page.getByTestId("gov-propose-submit").click();

    const entry = page.getByTestId("gov-proposal-card").filter({ hasText: "New entry at medicine/e2e-yarrow" }).first();
    await expect(entry).toBeVisible();
    await entry.getByTestId("gov-approve").click();
    await expect(
      page.getByTestId("gov-proposal-card").filter({ hasText: "New entry at medicine/e2e-yarrow" }).first().getByTestId("gov-proposal-progress"),
    ).toContainText("1 of 1 approvals");
    await page.getByTestId("gov-proposal-card").filter({ hasText: "New entry at medicine/e2e-yarrow" }).first().getByTestId("gov-apply").click();

    // Approved but NOT live: the card is staged, and the vault has no medicine note.
    const staged = page.getByTestId("gov-proposal-card").filter({ hasText: "New entry at medicine/e2e-yarrow" }).first();
    await expect(staged.getByTestId("gov-publish")).toBeVisible();
    {
      const r = await ownerFetch(`/api/notes?tag=medicine`);
      const notes = (await r.json()) as Array<{ content: string }>;
      expect(notes.some((n) => n.content.includes("Yarrow (e2e)"))).toBe(false);
    }

    // Publish → the note exists in the vault.
    await staged.getByTestId("gov-publish").click();
    await expect
      .poll(async () => {
        const r = await ownerFetch(`/api/notes?tag=medicine`);
        const notes = (await r.json()) as Array<{ content: string }>;
        return notes.some((n) => n.content.includes("Yarrow (e2e)"));
      })
      .toBe(true);

    // ── the constitution note reads as prose, generated from the rules ──
    {
      const r = await ownerFetch(`/api/notes?tag=governance-config`);
      const notes = (await r.json()) as Array<{ content: string }>;
      expect(notes[0]?.content).toContain("# Governance Constitution");
      expect(notes[0]?.content).toContain("Amendments to the constitution need 1 approval from Stewards");
    }

    // ── your access: the ratified role compiled into real content grants ──
    await page.reload();
    await expect(page.getByTestId("gov-your-access")).toBeVisible();
    await expect(page.getByTestId("gov-access-rows")).toContainText("via the steward role");

    // ── the audit trail recorded the journey ──
    await expect(page.getByTestId("gov-audit")).toBeVisible();
    await expect(page.getByTestId("gov-audit-action").first()).toBeVisible();
    await expect(page.getByTestId("gov-audit").getByText(/changed by amendment|set directly/).first()).toBeVisible();
  });

  test("a stranger cannot reach governance", async ({ page }) => {
    await page.goto("/governance");
    // No session → the login screen renders instead of the panel.
    await expect(page.getByText("Sign in to access commons governance.")).toBeVisible();
  });
});
