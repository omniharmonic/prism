/**
 * Governance integrity (WP0.3). The threat: anyone holding a whole-vault write
 * token can write `governance-*` notes straight into the vault, and before WP0.3
 * those notes WERE governance — a forged membership compiled into a real grant,
 * a forged vote counted toward an amendment.
 *
 * Families:
 *  - SIGNATURE: every authority field of every note type is covered (tampering
 *    any one breaks it), the id and tag are bound (copies and re-tags fail),
 *    derived prose is not covered (the constitution body can be regenerated).
 *  - FORGERY, END-TO-END: forged/copied/tampered notes written into the fake
 *    vault compile into NO grants, count as NO votes, and are logged once.
 *  - BACK-COMPAT: with no secret, forged notes are honored exactly as before.
 *  - MIGRATION: dry-run writes nothing; apply signs everything; re-run is a no-op.
 *  - CLI: refuses to run without an explicit env file.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { governance } from "../src/routes/governance";
import {
  GOV_SIG_FIELD,
  authorityProjection,
  govSigStatus,
  reportGovernanceIntegrity,
  setGovernanceSigningSecret,
  signGovernanceNote,
  verifyGovNote,
  withGovSig,
} from "../src/governance-integrity";
import { GOV_TAGS, loadState, loadVotesFor, parseMembership } from "../src/governance-store";
import type { GovTag } from "../src/governance-fields";
import { loadGovernance } from "../src/governance-service";
import { compileGovernanceGrants, reconcileGovernanceGrants } from "../src/governance-grants";
import { signExistingGovernance } from "../src/governance-migrate";
import { vault } from "../src/parachute";
import { grantsForUser } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

const SECRET = "test-governance-signing-secret-0123456789abcdef";
const OWNER = "owner@test.local";
const A1 = "a1@test.local";
const A2 = "a2@test.local";
const FORGER = "forger@test.local";

let fv: FakeVault;
let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  setGovernanceSigningSecret(SECRET);
  warnings = [];
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
  setGovernanceSigningSecret(undefined);
  fv.restore();
});

const cookieFor = (e: string) => sessionCookie(makeSession(e));
function jreq(path: string, cookie: string | undefined, method = "GET", payload?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return governance.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();
const notesTagged = (tag: string) => [...fv.notes.values()].filter((n) => (n.tags ?? []).includes(tag));

/** Bootstrap an enabled commons THROUGH THE ROUTES (so every note is service-signed):
 *  an `admin` role (amend power), a tag-scoped `gardener` role with edit caps on
 *  #medicine, an amend policy (threshold 2), A1 + A2 as admins, locked. */
async function bootstrap(threshold = 2): Promise<{ policyId: string }> {
  const owner = cookieFor(OWNER);
  assert.equal((await jreq("/roles", owner, "POST", { name: "admin", powers: ["amend_governance"] })).status, 200);
  assert.equal(
    (
      await jreq("/roles", owner, "POST", {
        name: "gardener",
        scopeType: "tag",
        scope: "medicine",
        capabilities: ["view", "edit"],
      })
    ).status,
    200,
  );
  const pol = await body(
    await jreq("/policies", owner, "POST", {
      action: "amend_governance",
      thresholdN: threshold,
      distinctRequired: false, // the harshest case for vote duplication
      eligibleRole: "admin",
    }),
  );
  for (const a of [A1, A2]) await jreq("/memberships", owner, "POST", { subject: a, role: "admin" });
  const cfg = await jreq("/config", owner, "POST", {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy: pol.note.id,
    defaultEligibleRole: "admin",
  });
  assert.equal(cfg.status, 200, "bootstrap must ratify");
  return { policyId: pol.note.id };
}

// ── signature: coverage, binding, exclusions ──────────────────────────────────

/** A representative, fully-populated metadata object per note type. */
const SAMPLES: Record<GovTag, { metadata: Record<string, unknown>; content: string }> = {
  "governance-config": {
    metadata: { enabled: true, bootstrap_owner: OWNER, amend_policy: "p1", default_threshold_n: 2, default_eligible_role: "admin" },
    content: "# Constitution prose",
  },
  "governance-role": {
    metadata: { name: "gardener", powers: ["publish"], scope_type: "tag", scope: "medicine", capabilities: ["view", "edit"], assigns: ["helper"] },
    content: "# Governance role: gardener",
  },
  "governance-membership": {
    metadata: { subject: A1, role: "gardener", granted_by: OWNER, expires_at: "2030-01-01T00:00:00.000Z" },
    content: "# Governance membership",
  },
  "governance-policy": {
    metadata: {
      action: "amend_governance",
      scope_type: "global",
      scope: "",
      threshold_n: 2,
      quorum: 1,
      distinct_required: true,
      eligible_role: "admin",
      window_seconds: 60,
      auto_publish: false,
    },
    content: "# Governance policy",
  },
  "governance-proposal": {
    metadata: { action: "amend_governance", target: "governance", state: "open", opened_by: A1, opened_at: "2026-01-01T00:00:00.000Z", payload: '{"kind":"add_membership"}' },
    content: "# Proposal",
  },
  "governance-vote": {
    metadata: { proposal: "p9", voter: A1, vote: "approve", at: "2026-01-01T00:00:00.000Z", reason: "" },
    content: "# Vote",
  },
  "governance-audit": {
    metadata: { action: "direct:add_role", actor: OWNER, before: "", after: "{}", at: "2026-01-01T00:00:00.000Z" },
    content: "# Audit",
  },
  "governance-revision": {
    metadata: { note: "n1", parent: "", proposal: "p9", author: A1, origin: "proposal", published: false, at: "2026-01-01T00:00:00.000Z", payload: "" },
    content: "the proposed text that will go live",
  },
};

/** A different value of the same broad type — enough to change the coerced value. */
function tamper(v: unknown): unknown {
  if (typeof v === "boolean") return !v;
  if (typeof v === "number") return v + 7;
  if (Array.isArray(v)) return [...v, "extra"];
  return `${String(v)}-forged`;
}

for (const tag of Object.keys(SAMPLES) as GovTag[]) {
  test(`${tag}: a service signature verifies, and tampering ANY authority field breaks it`, () => {
    const { metadata, content } = SAMPLES[tag];
    const note = { id: "note-1", content, metadata: withGovSig(tag, "note-1", metadata, content) };
    assert.equal(govSigStatus(tag, note), "valid");

    const covered = Object.keys(authorityProjection(tag, metadata, content)).filter((k) => k !== "content_sha256");
    assert.deepEqual(new Set(covered), new Set(Object.keys(metadata)), "the projection covers exactly the serialized fields");
    for (const key of covered) {
      const forged = { ...note, metadata: { ...note.metadata, [key]: tamper(metadata[key]) } };
      assert.equal(govSigStatus(tag, forged), "invalid", `tampering ${tag}.${key} must break the signature`);
    }
  });
}

test("the signature binds the note id (a copy does not verify) and the tag (a re-tag does not verify)", () => {
  const { metadata, content } = SAMPLES["governance-membership"];
  const signed = { id: "m-1", content, metadata: withGovSig(GOV_TAGS.membership, "m-1", metadata, content) };
  assert.equal(govSigStatus(GOV_TAGS.membership, { ...signed, id: "m-copy" }), "invalid");
  assert.equal(govSigStatus(GOV_TAGS.role, signed), "invalid");
});

test("a revision's CONTENT is covered; derived prose on other types is not", () => {
  const rev = SAMPLES["governance-revision"];
  const signedRev = { id: "r1", content: rev.content, metadata: withGovSig(GOV_TAGS.revision, "r1", rev.metadata, rev.content) };
  assert.equal(govSigStatus(GOV_TAGS.revision, { ...signedRev, content: "something else entirely" }), "invalid");

  const cfg = SAMPLES["governance-config"];
  const signedCfg = { id: "c1", content: cfg.content, metadata: withGovSig(GOV_TAGS.config, "c1", cfg.metadata, cfg.content) };
  assert.equal(govSigStatus(GOV_TAGS.config, { ...signedCfg, content: "# regenerated constitution prose" }), "valid");
});

test("non-authority metadata keys and equivalent encodings do not affect the signature", () => {
  const { metadata, content } = SAMPLES["governance-policy"];
  const signed = withGovSig(GOV_TAGS.policy, "p1", metadata, content);
  // an unrelated key (e.g. a vault default-fill) and a numeric-string re-encoding
  const noisy = { ...signed, some_other_field: "x", threshold_n: "2" };
  assert.equal(govSigStatus(GOV_TAGS.policy, { id: "p1", content, metadata: noisy }), "valid");
});

test("missing vs invalid signatures are distinguished; a wrong secret is invalid", () => {
  const { metadata, content } = SAMPLES["governance-vote"];
  assert.equal(govSigStatus(GOV_TAGS.vote, { id: "v1", content, metadata }), "missing");
  const sig = signGovernanceNote(GOV_TAGS.vote, "v1", metadata, content, "a-completely-different-secret-value-000000");
  assert.equal(govSigStatus(GOV_TAGS.vote, { id: "v1", content, metadata: { ...metadata, [GOV_SIG_FIELD]: sig } }), "invalid");
});

// ── service writes are signed ─────────────────────────────────────────────────

test("every governance note the service writes carries a gov_sig that verifies", async () => {
  await bootstrap();
  const all = [...fv.notes.values()].filter((n) => (n.tags ?? []).some((t) => t.startsWith("governance-")));
  assert.ok(all.length >= 7, "config, roles, policy, memberships and audit entries were written");
  for (const n of all) {
    const tag = n.tags!.find((t) => t.startsWith("governance-")) as GovTag;
    assert.equal(govSigStatus(tag, n), "valid", `${tag} ${n.id} should verify`);
  }
  const s = await loadGovernance(vault, OWNER);
  assert.equal(s.config.enabled, true);
  assert.equal(s.memberships.length, 2);
  assert.equal(warnings.length, 0, "nothing was rejected");
});

// ── forgery, end-to-end ───────────────────────────────────────────────────────

test("a FORGED membership written straight to the vault compiles into NO grant", async () => {
  await bootstrap();
  const put = fv.put({
    id: "forged-membership",
    tags: [GOV_TAGS.membership],
    metadata: { subject: FORGER, role: "gardener", granted_by: OWNER, expires_at: "" },
  });

  const s = await loadGovernance(vault, OWNER);
  assert.ok(!s.memberships.some((m) => m.subject === FORGER), "the forged membership is not governance state");
  assert.ok(!compileGovernanceGrants(s).some((g) => g.subject === FORGER), "and compiles into no grant");
  reconcileGovernanceGrants("primary", s);
  assert.equal(grantsForUser(FORGER).length, 0, "no grant row exists for the forger");

  // Logged loudly, once per note id — id + type, never content.
  const hits = warnings.filter((w) => w.includes(put.id));
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /INTEGRITY: ignoring governance-membership note forged-membership — missing gov_sig/);
  await loadGovernance(vault, OWNER);
  assert.equal(warnings.filter((w) => w.includes(put.id)).length, 1, "warned only once per note id");
});

test("a byte-for-byte COPY of a legit signed membership (new id) is ignored", async () => {
  await bootstrap();
  const legit = notesTagged(GOV_TAGS.membership).find((n) => parseMembership(n).subject === A1)!;
  fv.put({ id: "copied", tags: [GOV_TAGS.membership], metadata: { ...legit.metadata!, subject: FORGER } });
  fv.put({ id: "copied-verbatim", tags: [GOV_TAGS.membership], metadata: { ...legit.metadata! } });
  const s = await loadGovernance(vault, OWNER);
  assert.equal(s.memberships.length, 2, "only the two service-written memberships count");
  assert.ok(!s.memberships.some((m) => m.subject === FORGER));
});

test("TAMPERING a legit membership (role, expiry) directly in the vault voids it", async () => {
  await bootstrap();
  const legit = notesTagged(GOV_TAGS.membership).find((n) => parseMembership(n).subject === A1)!;
  legit.metadata = { ...legit.metadata!, role: "gardener" };
  let s = await loadGovernance(vault, OWNER);
  assert.ok(!s.memberships.some((m) => m.subject === A1), "an altered role is not honored");

  const other = notesTagged(GOV_TAGS.membership).find((n) => parseMembership(n).subject === A2)!;
  other.metadata = { ...other.metadata!, expires_at: "2999-01-01T00:00:00.000Z" };
  s = await loadGovernance(vault, OWNER);
  assert.equal(s.memberships.length, 0);
});

test("FORGED votes are not counted: an amendment cannot be pushed through with them", async () => {
  await bootstrap(2);
  const open = await jreq("/proposals", cookieFor(A1), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify({ kind: "add_membership", membership: { subject: FORGER, role: "admin" } }),
  });
  const { id } = await body(open);
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor(A1), "POST", { vote: "approve" })).status, 200);

  // Forge A2's approval, and duplicate A1's signed vote under a new id.
  fv.put({ id: "forged-vote", tags: [GOV_TAGS.vote], metadata: { proposal: id, voter: A2, vote: "approve", at: new Date().toISOString(), reason: "" } });
  const a1Vote = notesTagged(GOV_TAGS.vote).find((n) => n.metadata?.voter === A1)!;
  fv.put({ id: "dup-vote", tags: [GOV_TAGS.vote], metadata: { ...a1Vote.metadata! } });

  const votes = await loadVotesFor(vault, id);
  assert.deepEqual(votes.map((v) => v.voter), [A1], "only the real vote counts");
  const detail = await body(await jreq(`/proposals/${id}`, cookieFor(OWNER)));
  assert.equal(detail.evaluation.approvals, 1);

  const apply = await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST");
  assert.equal(apply.status, 409, "insufficient approvals");
  assert.ok(!(await loadGovernance(vault, OWNER)).memberships.some((m) => m.subject === FORGER));

  // With the real second approval it applies — and the new membership is signed.
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor(A2), "POST", { vote: "approve" })).status, 200);
  assert.equal((await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST")).status, 200);
  assert.ok((await loadGovernance(vault, OWNER)).memberships.some((m) => m.subject === FORGER));
});

test("a tampered vote (reject flipped to approve) is not counted", async () => {
  await bootstrap(1);
  const { id } = await body(
    await jreq("/proposals", cookieFor(A1), "POST", {
      action: "amend_governance",
      target: "governance",
      payload: JSON.stringify({ kind: "remove_role", ref: "gardener" }),
    }),
  );
  await jreq(`/proposals/${id}/vote`, cookieFor(A2), "POST", { vote: "reject" });
  const v = notesTagged(GOV_TAGS.vote)[0]!;
  v.metadata = { ...v.metadata!, vote: "approve" };
  assert.equal((await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST")).status, 409);
});

test("a FORGED or tampered proposal does not exist to governance (404, not listed, not appliable)", async () => {
  await bootstrap(1);
  fv.put({
    id: "forged-proposal",
    tags: [GOV_TAGS.proposal],
    metadata: { action: "amend_governance", target: "governance", state: "open", opened_by: A1, opened_at: new Date().toISOString(), payload: "{}" },
  });
  assert.equal((await jreq("/proposals/forged-proposal", cookieFor(OWNER))).status, 404);
  assert.ok(!(await body(await jreq("/proposals", cookieFor(OWNER)))).proposals.some((p: { id: string }) => p.id === "forged-proposal"));

  // Swap the payload of a real, approved-but-unapplied proposal → it stops existing.
  const { id } = await body(
    await jreq("/proposals", cookieFor(A1), "POST", {
      action: "amend_governance",
      target: "governance",
      payload: JSON.stringify({ kind: "remove_role", ref: "gardener" }),
    }),
  );
  await jreq(`/proposals/${id}/vote`, cookieFor(A2), "POST", { vote: "approve" });
  const p = fv.notes.get(id)!;
  p.metadata = { ...p.metadata!, payload: JSON.stringify({ kind: "add_membership", membership: { subject: FORGER, role: "admin" } }) };
  assert.equal((await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST")).status, 404);
  assert.ok(!(await loadGovernance(vault, OWNER)).memberships.some((m) => m.subject === FORGER));
});

test("a newer FORGED config note cannot disable or re-own governance", async () => {
  await bootstrap();
  fv.put({
    id: "forged-config",
    tags: [GOV_TAGS.config],
    updatedAt: "2099-01-01T00:00:00.000Z",
    metadata: { enabled: false, bootstrap_owner: FORGER, amend_policy: "", default_threshold_n: 1, default_eligible_role: "" },
  });
  // Put the forgery FIRST (the vault lists newest-first).
  const entries = [...fv.notes.entries()];
  fv.notes.clear();
  fv.notes.set("forged-config", entries.find(([k]) => k === "forged-config")![1]);
  for (const [k, v] of entries) if (k !== "forged-config") fv.notes.set(k, v);

  const s = await loadGovernance(vault, OWNER);
  assert.equal(s.config.enabled, true);
  assert.equal(s.config.bootstrapOwner, OWNER);
});

test("regenerating the constitution prose (content-only) keeps the config note valid", async () => {
  await bootstrap();
  const cfg = notesTagged(GOV_TAGS.config)[0]!;
  assert.ok(cfg.content.length > "# Governance Constitution".length, "prose was written after the mutation");
  assert.equal(govSigStatus(GOV_TAGS.config, cfg), "valid");
});

test("the service never re-signs a forged note: an upsert over a forged membership leaves it inert", async () => {
  await bootstrap();
  fv.put({ id: "forged-upsert", tags: [GOV_TAGS.membership], metadata: { subject: FORGER, role: "gardener", granted_by: "", expires_at: "" } });
  // A delegated/amended add of the SAME (subject, role) creates a new signed note
  // rather than signing the forgery in place.
  const { id } = await body(
    await jreq("/proposals", cookieFor(A1), "POST", {
      action: "amend_governance",
      target: "governance",
      payload: JSON.stringify({ kind: "add_membership", membership: { subject: FORGER, role: "gardener" } }),
    }),
  );
  for (const v of [A1, A2]) await jreq(`/proposals/${id}/vote`, cookieFor(v), "POST", { vote: "approve" });
  assert.equal((await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST")).status, 200);
  assert.equal(govSigStatus(GOV_TAGS.membership, fv.notes.get("forged-upsert")!), "missing", "the forgery was not laundered");
});

test("content proposals cannot create or edit governance notes when integrity is on", async () => {
  await bootstrap();
  const create = await jreq("/content/propose", cookieFor(A1), "POST", {
    action: "new_entry",
    path: "x",
    tags: [GOV_TAGS.membership],
    metadata: { subject: FORGER, role: "admin" },
  });
  assert.equal(create.status, 400);
  const cfgId = notesTagged(GOV_TAGS.config)[0]!.id;
  const edit = await jreq("/content/propose", cookieFor(A1), "POST", { action: "edit_note", target: cfgId, content: "x" });
  assert.equal(edit.status, 400);
});

// ── back-compat: no secret ────────────────────────────────────────────────────

test("NO secret: behaves exactly as before — forged notes are trusted and nothing is signed", async () => {
  setGovernanceSigningSecret(null);
  await bootstrap();
  assert.ok(
    [...fv.notes.values()].every((n) => !(n.metadata && GOV_SIG_FIELD in n.metadata)),
    "no gov_sig is written without a secret",
  );
  fv.put({ id: "forged", tags: [GOV_TAGS.membership], metadata: { subject: FORGER, role: "gardener", granted_by: "", expires_at: "" } });
  const s = await loadState(vault);
  assert.ok(s.memberships.some((m) => m.subject === FORGER), "the pre-WP0.3 trust model is unchanged");
  assert.equal(verifyGovNote(GOV_TAGS.membership, fv.notes.get("forged")!), true);
  assert.equal(warnings.length, 0);
});

test("startup report: warns when integrity is off or the secret is weak; silent when strong", () => {
  const logs: string[] = [];
  setGovernanceSigningSecret(null);
  assert.match(reportGovernanceIntegrity((m) => logs.push(m))!, /integrity is OFF/);
  setGovernanceSigningSecret("short");
  assert.match(reportGovernanceIntegrity((m) => logs.push(m))!, /shorter than 32/);
  setGovernanceSigningSecret(SECRET);
  assert.equal(reportGovernanceIntegrity((m) => logs.push(m)), null);
  assert.equal(logs.length, 2);
});

// ── migration ─────────────────────────────────────────────────────────────────

/** A pre-WP0.3 commons: bootstrapped with no secret (so every note is unsigned). */
async function legacyCommons(): Promise<void> {
  setGovernanceSigningSecret(null);
  await bootstrap();
  setGovernanceSigningSecret(SECRET);
}

const patches = () => fv.calls.filter((c) => c.method === "PATCH");

test("migration: turning the secret on WITHOUT migrating hides the legacy constitution", async () => {
  await legacyCommons();
  const s = await loadGovernance(vault, OWNER);
  assert.equal(s.config.enabled, false);
  assert.equal(s.memberships.length, 0);
});

test("migration: dry run lists every governance note and writes nothing", async () => {
  await legacyCommons();
  const before = patches().length;
  const res = await signExistingGovernance(vault, { secret: SECRET, apply: false });
  assert.equal(patches().length, before, "no PATCH in a dry run");
  assert.ok(res.plan.length >= 7);
  assert.ok(res.plan.every((i) => i.action === "sign"));
  assert.equal(res.remaining, res.plan.length);
  assert.ok(res.plan.some((i) => i.tag === GOV_TAGS.membership && i.summary === `${A1} → admin`), "roster is legible for review");
  assert.ok(res.plan.every((i) => !i.summary.includes("Constitution")), "summaries carry no note content");
});

test("migration: apply signs everything, the constitution is back, and a re-run is a no-op", async () => {
  await legacyCommons();
  const res = await signExistingGovernance(vault, { secret: SECRET, apply: true });
  assert.equal(res.written.length, res.plan.length);
  assert.equal(res.remaining, 0);
  const s = await loadGovernance(vault, OWNER);
  assert.equal(s.config.enabled, true);
  assert.equal(s.memberships.length, 2);

  const before = patches().length;
  const again = await signExistingGovernance(vault, { secret: SECRET, apply: true });
  assert.equal(again.written.length, 0);
  assert.ok(again.plan.every((i) => i.action === "skip-valid"));
  assert.equal(patches().length, before, "idempotent: nothing written the second time");
});

test("migration: stale signatures are re-signed; multi-governance-tag notes are skipped for a human", async () => {
  await bootstrap(); // signed under SECRET
  const NEW = "rotated-governance-signing-secret-abcdef0123456789";
  fv.put({ id: "two-tags", tags: [GOV_TAGS.membership, GOV_TAGS.role], metadata: { subject: "x", role: "y" } });
  const res = await signExistingGovernance(vault, { secret: NEW, apply: true });
  assert.ok(res.plan.filter((i) => i.id !== "two-tags").every((i) => i.action === "resign"));
  assert.equal(res.plan.find((i) => i.id === "two-tags")!.action, "skip-ambiguous");
  assert.ok(!res.written.includes("two-tags"));
  setGovernanceSigningSecret(NEW);
  assert.equal((await loadGovernance(vault, OWNER)).memberships.length, 2);
});

// ── CLI guard ─────────────────────────────────────────────────────────────────

test("the sign-existing CLI refuses to run without an explicit --env file", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(here, "../scripts/governance-sign-existing.ts");
  const r = spawnSync(process.execPath, ["--import", "tsx", script, "--apply"], {
    cwd: resolve(here, ".."),
    encoding: "utf8",
    // No vault credentials in the child's env — even if the guard failed it could reach nothing.
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /explicit --env/);
});
