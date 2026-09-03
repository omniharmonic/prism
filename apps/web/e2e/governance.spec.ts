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

// P4 fixtures — the contributor, the page they may improve but not publish.
const CONTRIBUTOR = "e2e-contributor@test.local";
const CONTRIBUTOR_PASSWORD = "e2e-contributor-password";
const GOVERNED_TAG = "medicine";
const GOVERNED_PATH = "e2e-governed-page";
const ORIGINAL_HTML = "<p>Original body.</p>";
const CONTRIBUTION = " Plus a contributor sentence.";

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

  /**
   * P4 — the wiki moderation loop, end to end through the real UI.
   *
   * A contributor holds `suggest` (not `edit`) on a governed note. In the app the
   * editor stays writable but autosave is off: their change leaves as an
   * `edit_note` PROPOSAL. A steward then sees it in the "Content changes" queue,
   * beside a diff against the live text, and approving it publishes the change.
   *
   * The two halves run in separate browser contexts — the contributor never
   * borrows the owner's session, so the caps the banner reacts to are the real
   * ones the gateway computed for them.
   */
  test("a contributor proposes from the editor; a steward reviews and it goes live", async ({ page, browser }) => {
    test.setTimeout(180_000);
    // Start from a blank constitution (the first test leaves a locked one).
    await resetGovernanceNotes();
    await loginAsOwner(page);

    // ── a constitution where stewards decide #medicine edits, 1 approval, live on apply ──
    const gov = async (path: string, payload: unknown) => {
      const r = await ownerFetch(`/api/governance${path}`, { method: "POST", body: JSON.stringify(payload) });
      const body = (await r.json()) as { note?: { id: string }; error?: string };
      expect(r.status, `${path} → ${JSON.stringify(body)}`).toBeLessThan(300);
      return body;
    };
    await gov("/roles", { name: "steward", powers: ["publish", "amend_governance"], capabilities: ["view", "edit"] });
    const amend = await gov("/policies", { action: "amend_governance", thresholdN: 1, eligibleRole: "steward" });
    await gov("/policies", {
      action: "edit_note",
      scopeType: "tag",
      scope: GOVERNED_TAG,
      thresholdN: 1,
      eligibleRole: "steward",
      autoPublish: true,
    });
    await gov("/memberships", { subject: OWNER_EMAIL, role: "steward" });
    await gov("/config", {
      enabled: true,
      bootstrapOwner: OWNER_EMAIL,
      amendPolicy: amend.note!.id,
      defaultEligibleRole: "steward",
    });

    // ── the governed page itself (HTML body: the editor then needs no md→html trip) ──
    const created = await ownerFetch(`/api/notes`, {
      method: "POST",
      body: JSON.stringify({ content: ORIGINAL_HTML, path: GOVERNED_PATH, tags: [GOVERNED_TAG] }),
    });
    expect(created.ok).toBeTruthy();
    const noteId = ((await created.json()) as { id: string }).id;

    // ── the contributor: suggest, NOT edit (auto-invited by the share) ──
    const shared = await ownerFetch(`/acl/tags/${GOVERNED_TAG}/people`, {
      method: "PUT",
      body: JSON.stringify({ email: CONTRIBUTOR, caps: ["view", "comment", "suggest"] }),
    });
    expect(shared.ok).toBeTruthy();
    const inviteUrl = ((await shared.json()) as { inviteUrl?: string }).inviteUrl;

    const contributorCtx = await browser.newContext();
    const contributor = await contributorCtx.newPage();
    if (inviteUrl) {
      const token = new URL(inviteUrl).searchParams.get("token");
      const reg = await contributor.request.post(`${BASE_URL}/auth/register`, {
        data: { token, name: "Contributor", password: CONTRIBUTOR_PASSWORD },
      });
      expect(reg.ok(), await reg.text()).toBeTruthy();
    } else {
      // Re-run against a vault where the account already exists.
      const login = await contributor.request.post(`${BASE_URL}/auth/login`, {
        data: { email: CONTRIBUTOR, password: CONTRIBUTOR_PASSWORD },
      });
      expect(login.ok(), await login.text()).toBeTruthy();
    }

    try {
      // The gateway tells the client what this person may do — that annotation is
      // the ONLY thing the review banner keys on (and the only reason the desktop
      // app is untouched: it never sees it).
      const seen = await contributor.request.get(`${BASE_URL}/api/notes/${encodeURIComponent(noteId)}`);
      const caps = ((await seen.json()) as { _caps?: string[] })._caps ?? [];
      expect(caps.sort()).toEqual(["comment", "suggest", "view"]);

      // ── in the app: open the page from the sidebar and see the review banner ──
      await contributor.goto("/");
      await contributor.getByText(GOVERNED_PATH, { exact: true }).click();
      const banner = contributor.getByTestId("review-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute("data-review-mode", "propose");
      // The history affordance is right there, and honest about an unedited page.
      await contributor.getByTestId("review-history-toggle").click();
      await expect(contributor.getByTestId("review-history")).toContainText("No recorded revisions yet");

      // ── edit locally, then submit for review (autosave is suppressed) ──
      const editor = contributor.locator(".prose-editor");
      await editor.click();
      await contributor.keyboard.press("End");
      await contributor.keyboard.type(CONTRIBUTION);
      await contributor.getByTestId("submit-for-review").click();
      await expect(contributor.getByTestId("review-submitted")).toContainText("Submitted for review");

      // Nothing was written to the note itself — a proposal is not an edit.
      {
        const r = await ownerFetch(`/api/notes/${encodeURIComponent(noteId)}`);
        expect(((await r.json()) as { content: string }).content).not.toContain(CONTRIBUTION);
      }

      // ── the steward's queue: grouped, counted, diffed ──
      await page.goto("/governance");
      await expect(page.getByTestId("gov-group-content")).toBeVisible();
      await expect(page.getByTestId("gov-group-content-count")).toContainText("1");
      await expect(page.getByTestId("review-chip")).toContainText("1 awaiting review");

      const card = page.getByTestId("gov-proposal-card").filter({ hasText: "Edit to note" }).first();
      await expect(card.getByTestId("gov-proposal-title")).toContainText(noteId);
      // The diff shows the live text beside the contributor's version.
      await expect(card.getByTestId("gov-proposal-diff")).toContainText("Original body");
      await expect(card.getByTestId("gov-proposal-diff")).toContainText(CONTRIBUTION);
      await expect(card.getByTestId("gov-proposal-progress")).toContainText("0 of 1 approvals");

      // ── approve + apply → the rule auto-publishes, so the page really changes ──
      await card.getByTestId("gov-approve").click();
      const approved = page.getByTestId("gov-proposal-card").filter({ hasText: "Edit to note" }).first();
      await expect(approved.getByTestId("gov-proposal-progress")).toContainText("1 of 1 approvals");
      await approved.getByTestId("gov-apply").click();

      await expect
        .poll(async () => {
          const r = await ownerFetch(`/api/notes/${encodeURIComponent(noteId)}`);
          return ((await r.json()) as { content: string }).content;
        })
        .toContain(CONTRIBUTION);
    } finally {
      await contributorCtx.close();
      await ownerFetch(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" }).catch(() => {});
    }
  });

  test("a stranger cannot reach governance", async ({ page }) => {
    await page.goto("/governance");
    // No session → the login screen renders instead of the panel.
    await expect(page.getByText("Sign in to access commons governance.")).toBeVisible();
  });
});
