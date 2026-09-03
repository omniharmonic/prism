/**
 * The governance→grants bridge (P2) — the seam where a constitution stops being
 * a description of the commons and starts being its access control.
 *
 * Four families:
 *  - COMPILE: the pure `state → desired grants` function. Every rule about what a
 *    role confers lives here, so every rule is tested here: the enabled gate,
 *    scope→resource mapping, expiry, membership-by-name-or-id, cap union.
 *  - RECONCILE: convergence against the real grants table — materialize, repair
 *    drift, revoke on removal, revoke EVERYTHING on disable, and never once touch
 *    a grant a human made.
 *  - END-TO-END: a member reaches a real note through the real /api gateway
 *    purely because the constitution says so — and loses it when it stops saying
 *    so. This is the test that proves governance and permissions are wired
 *    together, and that `effectiveCaps` remained the only guard.
 *  - DELEGATION: post-lock stewardship via `assign_roles`, and the four ways it
 *    must refuse.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { governance } from "../src/routes/governance";
import { api } from "../src/routes/api";
import {
  compileGovernanceGrants,
  reconcileGovernanceGrants,
} from "../src/governance-grants";
import { runGovernanceReconcileOnce, resetGovernanceProbe } from "../src/worker/scheduler";
import type { GovernanceState, Role, Membership } from "../src/governance";
import { addGrant, grantsForUser, listGovernanceGrants, listGrantsForVault } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetGovernanceProbe();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const ADMIN = "a1@test.local";
const MEMBER = "herb@test.local";
const OTHER = "kai@test.local";
const cookieFor = (e: string) => sessionCookie(makeSession(e));

function jreq(app: typeof governance | typeof api, path: string, cookie: string | undefined, method = "GET", payload?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return app.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}
const gov = (path: string, cookie: string | undefined, method = "GET", payload?: unknown) =>
  jreq(governance, path, cookie, method, payload);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();

// ── pure compile ──────────────────────────────────────────────────────────────

const role = (over: Partial<Role>): Role => ({
  id: "r",
  name: "gardener",
  powers: [],
  scopeType: "global",
  scope: "",
  capabilities: [],
  assigns: [],
  ...over,
});

const state = (over: Partial<GovernanceState> & { roles?: Role[]; memberships?: Membership[] } = {}): GovernanceState => ({
  config: {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy: "pol",
    defaultThresholdN: 1,
    defaultEligibleRole: "admin",
    ...(over.config ?? {}),
  },
  roles: over.roles ?? [],
  memberships: over.memberships ?? [],
  policies: over.policies ?? [],
});

const NOW = Date.parse("2026-07-01T00:00:00Z");

test("a DRAFT constitution grants nothing — enabled is the gate", () => {
  const s = state({
    config: { enabled: false, bootstrapOwner: OWNER, amendPolicy: "pol", defaultThresholdN: 1, defaultEligibleRole: "admin" },
    roles: [role({ id: "r1", name: "gardener", scopeType: "tag", scope: "medicine", capabilities: ["view", "edit"] })],
    memberships: [{ subject: MEMBER, role: "gardener" }],
  });
  assert.deepEqual(compileGovernanceGrants(s, NOW), []);
});

test("a tag-scoped role compiles to a TAG grant; a global role to a VAULT grant", () => {
  const s = state({
    roles: [
      role({ id: "r1", name: "gardener", scopeType: "tag", scope: "medicine", capabilities: ["view", "edit"] }),
      role({ id: "r2", name: "steward", scopeType: "global", scope: "", capabilities: ["view"] }),
    ],
    memberships: [
      { subject: MEMBER, role: "gardener" },
      { subject: OTHER, role: "steward" },
    ],
  });
  const out = compileGovernanceGrants(s, NOW);
  const tagGrant = out.find((g) => g.subject === MEMBER)!;
  assert.equal(tagGrant.resource_type, "tag");
  assert.equal(tagGrant.resource, "medicine");
  assert.deepEqual(tagGrant.caps, ["edit", "view"]);
  assert.equal(tagGrant.created_by, "governance:r1");

  const vaultGrant = out.find((g) => g.subject === OTHER)!;
  assert.equal(vaultGrant.resource_type, "vault");
  assert.equal(vaultGrant.resource, "");
  assert.equal(vaultGrant.created_by, "governance:r2");
});

test("a role with NO capabilities is procedural — it compiles to nothing", () => {
  const s = state({
    roles: [role({ id: "r1", name: "arbiter", powers: ["publish"], capabilities: [] })],
    memberships: [{ subject: MEMBER, role: "arbiter" }],
  });
  assert.deepEqual(compileGovernanceGrants(s, NOW), []);
});

test("an EXPIRED membership compiles to nothing; a live one carries its expiry", () => {
  const s = state({
    roles: [role({ id: "r1", name: "gardener", capabilities: ["view"] })],
    memberships: [
      { subject: MEMBER, role: "gardener", expiresAt: "2026-06-01T00:00:00Z" }, // past
      { subject: OTHER, role: "gardener", expiresAt: "2026-08-01T00:00:00Z" }, // future
    ],
  });
  const out = compileGovernanceGrants(s, NOW);
  assert.deepEqual(out.map((g) => g.subject), [OTHER]);
  assert.equal(out[0]!.expires_at, Date.parse("2026-08-01T00:00:00Z"));
});

test("memberships resolve by role NAME or by role ID, identically", () => {
  const s = state({
    roles: [role({ id: "role-note-7", name: "gardener", scopeType: "tag", scope: "medicine", capabilities: ["view"] })],
    memberships: [
      { subject: MEMBER, role: "gardener" }, // by name
      { subject: OTHER, role: "role-note-7" }, // by id
    ],
  });
  const out = compileGovernanceGrants(s, NOW);
  assert.equal(out.length, 2);
  assert.ok(out.every((g) => g.resource === "medicine" && g.resource_type === "tag"));
});

test("two roles reaching the same scope UNION their caps, and the latest expiry wins (null = never)", () => {
  const s = state({
    roles: [
      role({ id: "r1", name: "reader", scopeType: "tag", scope: "medicine", capabilities: ["view"] }),
      role({ id: "r2", name: "editor", scopeType: "tag", scope: "medicine", capabilities: ["edit", "organize"] }),
    ],
    memberships: [
      { subject: MEMBER, role: "reader", expiresAt: "2026-08-01T00:00:00Z" },
      { subject: MEMBER, role: "editor", expiresAt: "2026-09-01T00:00:00Z" },
    ],
  });
  const out = compileGovernanceGrants(s, NOW);
  assert.equal(out.length, 1, "one grant per (subject, resource)");
  assert.deepEqual(out[0]!.caps, ["edit", "organize", "view"]);
  assert.equal(out[0]!.expires_at, Date.parse("2026-09-01T00:00:00Z"), "the longer term governs");
  assert.equal(out[0]!.created_by, "governance:r1", "attribution keeps the first role");

  // A permanent membership alongside a time-boxed one must not be cut short.
  const s2 = state({
    roles: s.roles,
    memberships: [
      { subject: MEMBER, role: "reader", expiresAt: "2026-08-01T00:00:00Z" },
      { subject: MEMBER, role: "editor", expiresAt: null },
    ],
  });
  assert.equal(compileGovernanceGrants(s2, NOW)[0]!.expires_at, null);
});

// ── reconcile against the real grants table ───────────────────────────────────

const gardenerState = (caps: Role["capabilities"], memberships: Membership[]): GovernanceState =>
  state({
    roles: [role({ id: "r1", name: "gardener", scopeType: "tag", scope: "medicine", capabilities: caps })],
    memberships,
  });

test("reconcile materializes an enabled constitution, then converges (idempotent)", () => {
  const s = gardenerState(["view", "edit"], [{ subject: MEMBER, role: "gardener" }]);
  assert.deepEqual(reconcileGovernanceGrants("primary", s), { added: 1, removed: 0, kept: 0 });

  const rows = listGovernanceGrants("primary");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.resource, "medicine");
  assert.deepEqual(rows[0]!.caps, ["edit", "view"]);
  assert.equal(rows[0]!.created_by, "governance:r1");

  assert.deepEqual(reconcileGovernanceGrants("primary", s), { added: 0, removed: 0, kept: 1 }, "second pass is a no-op");
});

test("a capability change on the role REPAIRS the stored grant", () => {
  reconcileGovernanceGrants("primary", gardenerState(["view"], [{ subject: MEMBER, role: "gardener" }]));
  const res = reconcileGovernanceGrants("primary", gardenerState(["view", "edit", "organize"], [{ subject: MEMBER, role: "gardener" }]));
  assert.deepEqual(res, { added: 1, removed: 1, kept: 0 }, "drift is repaired by replacement");
  const rows = listGovernanceGrants("primary");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.caps, ["edit", "organize", "view"]);
});

test("removing the membership removes exactly that grant; disabling removes them all", () => {
  const two: Membership[] = [{ subject: MEMBER, role: "gardener" }, { subject: OTHER, role: "gardener" }];
  reconcileGovernanceGrants("primary", gardenerState(["view"], two));
  assert.equal(listGovernanceGrants("primary").length, 2);

  reconcileGovernanceGrants("primary", gardenerState(["view"], [{ subject: MEMBER, role: "gardener" }]));
  assert.deepEqual(listGovernanceGrants("primary").map((g) => g.subject), [MEMBER]);

  // Disabling compiles to the empty set — that IS the revocation mechanism.
  const off = gardenerState(["view"], [{ subject: MEMBER, role: "gardener" }]);
  off.config.enabled = false;
  assert.deepEqual(reconcileGovernanceGrants("primary", off), { added: 0, removed: 1, kept: 0 });
  assert.equal(listGovernanceGrants("primary").length, 0);
});

test("human grants are sacrosanct — the reconciler never touches what it did not write", () => {
  addGrant({ subject_type: "user", subject: MEMBER, resource_type: "tag", resource: "medicine", level: "edit", created_by: "test" });
  addGrant({ subject_type: "user", subject: OTHER, resource_type: "note", resource: "n9", level: "view", created_by: "test" });

  reconcileGovernanceGrants("primary", gardenerState(["view"], [{ subject: MEMBER, role: "gardener" }]));
  // The governance grant sits alongside the identical human one, not on top of it.
  assert.equal(listGrantsForVault("primary").length, 3);

  const off = gardenerState(["view"], []);
  off.config.enabled = false;
  reconcileGovernanceGrants("primary", off);

  const survivors = listGrantsForVault("primary");
  assert.equal(survivors.length, 2, "a full revocation leaves every hand-made grant standing");
  assert.ok(survivors.every((g) => g.created_by === "test"));
});

test("an EXPIRED governance grant no longer reaches grantsForUser", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  // Compiled while still live (so the row is written), then read back after expiry.
  const s = gardenerState(["view", "edit"], [{ subject: MEMBER, role: "gardener", expiresAt: past }]);
  addGrant({
    subject_type: "user",
    subject: MEMBER,
    resource_type: "tag",
    resource: "medicine",
    level: "view",
    created_by: "governance:r1",
    caps: ["view", "edit"],
    expires_at: Date.parse(past),
  });
  assert.equal(listGovernanceGrants("primary").length, 1, "the row is still in the table");
  assert.deepEqual(grantsForUser(MEMBER, "primary"), [], "but it authorizes nothing");

  // And the reconciler cleans it up (the membership is inactive → compiles to nothing).
  assert.deepEqual(reconcileGovernanceGrants("primary", s), { added: 0, removed: 1, kept: 0 });
});

// ── end to end: the constitution reaches the content plane ────────────────────

/**
 * Stand up a real commons over the routes: an `admin` role that can amend, an
 * `herbalist` role scoped to #medicine carrying real content capabilities, and
 * the lock. Ratifying runs the reconcile, so grants exist when this returns.
 */
async function bootstrapCommons(): Promise<string> {
  const owner = cookieFor(OWNER);
  await gov("/roles", owner, "POST", { name: "admin", powers: ["amend_governance"] });
  const pol = await body(
    await gov("/policies", owner, "POST", { action: "amend_governance", thresholdN: 1, eligibleRole: "admin" }),
  );
  await gov("/memberships", owner, "POST", { subject: ADMIN, role: "admin" });
  await gov("/roles", owner, "POST", {
    name: "herbalist",
    powers: [],
    scopeType: "tag",
    scope: "medicine",
    capabilities: ["view", "suggest", "edit"],
  });
  await gov("/memberships", owner, "POST", { subject: MEMBER, role: "herbalist" });
  const cfg = await gov("/config", owner, "POST", {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy: pol.note.id,
    defaultEligibleRole: "admin",
  });
  assert.equal(cfg.status, 200, "the commons ratifies");
  return pol.note.id as string;
}

/** Open → approve → apply an amendment (the only post-lock path for most changes). */
async function amend(change: unknown): Promise<Response> {
  const open = await gov("/proposals", cookieFor(ADMIN), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify(change),
  });
  assert.equal(open.status, 201);
  const { id } = await body(open);
  assert.equal((await gov(`/proposals/${id}/vote`, cookieFor(ADMIN), "POST", { vote: "approve" })).status, 200);
  return gov(`/proposals/${id}/apply`, cookieFor(ADMIN), "POST");
}

test("a governance member reaches #medicine notes through the real gateway — and only those", async () => {
  fv.put({ id: "med1", content: "<p>yarrow</p>", tags: ["medicine"] });
  fv.put({ id: "fin1", content: "<p>budget</p>", tags: ["finance"] });
  await bootstrapCommons();

  // The constitution alone produced the access: no /acl call was ever made.
  const grants = grantsForUser(MEMBER, "primary");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.created_by?.startsWith("governance:"), true);

  const member = cookieFor(MEMBER);
  assert.equal((await jreq(api, "/notes/med1", member)).status, 200, "in scope: readable");
  const patched = await jreq(api, "/notes/med1", member, "PATCH", { content: "<p>yarrow, revised</p>" });
  assert.equal(patched.status, 200, "in scope: writable (the edit cap)");
  assert.equal(fv.notes.get("med1")!.content, "<p>yarrow, revised</p>");

  assert.equal((await jreq(api, "/notes/fin1", member)).status, 403, "out of scope: invisible");
  assert.equal((await jreq(api, "/notes/fin1", member, "PATCH", { content: "x" })).status, 403);

  const listed = (await body(await jreq(api, "/notes", member))) as Array<{ id: string }>;
  assert.deepEqual(listed.map((n) => n.id), ["med1"], "listing is bounded by the granted tag");
});

test("revoking the membership revokes the access, through the amendment path", async () => {
  fv.put({ id: "med1", content: "<p>yarrow</p>", tags: ["medicine"] });
  await bootstrapCommons();
  const member = cookieFor(MEMBER);
  assert.equal((await jreq(api, "/notes/med1", member)).status, 200);

  const res = await amend({ kind: "remove_membership", subject: MEMBER, role: "herbalist" });
  assert.equal(res.status, 200);

  assert.deepEqual(grantsForUser(MEMBER, "primary"), [], "the compiled grant is gone");
  assert.equal((await jreq(api, "/notes/med1", cookieFor(MEMBER))).status, 403, "access ends with the role");
});

test("amending a role's capabilities re-materializes the grants it confers", async () => {
  fv.put({ id: "med1", content: "<p>yarrow</p>", tags: ["medicine"] });
  await bootstrapCommons();

  assert.equal(
    (await amend({ kind: "update_role", ref: "herbalist", role: { capabilities: ["view"] } })).status,
    200,
  );
  const caps = grantsForUser(MEMBER, "primary")[0]!.caps;
  assert.deepEqual(caps, ["view"]);
  assert.equal((await jreq(api, "/notes/med1", cookieFor(MEMBER))).status, 200, "still readable");
  assert.equal(
    (await jreq(api, "/notes/med1", cookieFor(MEMBER), "PATCH", { content: "x" })).status,
    403,
    "no longer writable",
  );
});

test("the worker reconcile is a no-op with no constitution, and converges with one", async () => {
  assert.equal(await runGovernanceReconcileOnce(), null, "nothing to do, and no state load");
  resetGovernanceProbe();
  await bootstrapCommons();
  resetGovernanceProbe();
  assert.deepEqual(await runGovernanceReconcileOnce(), { added: 0, removed: 0, kept: 1 }, "already converged");
});

// ── delegated role assignment (assign_roles) ──────────────────────────────────

/**
 * A commons where `steward` may staff `gardener` (and, wrongly, `admin` — which
 * the hard rule must still refuse), plus a tag-scoped steward for the scope test.
 */
async function bootstrapDelegation(): Promise<void> {
  const owner = cookieFor(OWNER);
  await gov("/roles", owner, "POST", { name: "admin", powers: ["amend_governance"] });
  const pol = await body(
    await gov("/policies", owner, "POST", { action: "amend_governance", thresholdN: 1, eligibleRole: "admin" }),
  );
  await gov("/memberships", owner, "POST", { subject: ADMIN, role: "admin" });
  await gov("/roles", owner, "POST", { name: "gardener", scopeType: "tag", scope: "medicine", capabilities: ["view"] });
  await gov("/roles", owner, "POST", { name: "hydrologist", scopeType: "tag", scope: "watershed", capabilities: ["view"] });
  // A global steward who may staff the gardener role — and names `admin` too, to
  // prove that listing a constitutional role does not make it assignable.
  await gov("/roles", owner, "POST", { name: "steward", powers: ["assign_roles"], assigns: ["gardener", "admin"] });
  // A #medicine-scoped steward who names a #watershed role — right power, wrong scope.
  await gov("/roles", owner, "POST", {
    name: "med-steward",
    powers: ["assign_roles"],
    scopeType: "tag",
    scope: "medicine",
    assigns: ["hydrologist"],
  });
  await gov("/memberships", owner, "POST", { subject: ADMIN, role: "steward" });
  await gov("/memberships", owner, "POST", { subject: OTHER, role: "med-steward" });
  const cfg = await gov("/config", owner, "POST", {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy: pol.note.id,
    defaultEligibleRole: "admin",
  });
  assert.equal(cfg.status, 200);
}

test("assign_roles lets a steward add and remove a listed role post-lock, with an audit trail", async () => {
  await bootstrapDelegation();
  const steward = cookieFor(ADMIN);

  const add = await gov("/memberships", steward, "POST", { subject: MEMBER, role: "gardener" });
  assert.equal(add.status, 200, "no amendment needed for routine stewardship");
  assert.equal(grantsForUser(MEMBER, "primary").length, 1, "and the access materialized");

  const rm = await gov("/memberships", steward, "DELETE", { subject: MEMBER, role: "gardener" });
  assert.equal(rm.status, 200);
  assert.deepEqual(grantsForUser(MEMBER, "primary"), []);

  const actions = (await body(await gov("/audit", cookieFor(OWNER)))).audit.map((a: { action: string }) => a.action);
  assert.ok(actions.includes("delegated:add_membership"), "the delegation is legible in the audit");
  assert.ok(actions.includes("delegated:remove_membership"));
});

test("delegation refuses: an unlisted role, a mismatched scope, and anything constitutional", async () => {
  await bootstrapDelegation();

  // (1) not in `assigns` — hydrologist is named only by med-steward.
  const unlisted = await gov("/memberships", cookieFor(ADMIN), "POST", { subject: MEMBER, role: "hydrologist" });
  assert.equal(unlisted.status, 403);
  assert.equal((await body(unlisted)).error, "requires_proposal");

  // (2) right power, wrong scope: a #medicine steward cannot staff #watershed.
  const crossScope = await gov("/memberships", cookieFor(OTHER), "POST", { subject: MEMBER, role: "hydrologist" });
  assert.equal(crossScope.status, 403);
  assert.equal((await body(crossScope)).error, "requires_proposal");

  // (3) the hard rule: a role carrying amend_governance is never delegable, even
  //     though `steward.assigns` explicitly lists it.
  const constitutional = await gov("/memberships", cookieFor(ADMIN), "POST", { subject: MEMBER, role: "admin" });
  assert.equal(constitutional.status, 403);
  assert.equal((await body(constitutional)).error, "requires_proposal");

  // (4) someone with no assign_roles power at all.
  const nobody = await gov("/memberships", cookieFor(MEMBER), "POST", { subject: MEMBER, role: "gardener" });
  assert.equal(nobody.status, 403);
  assert.equal((await body(nobody)).error, "requires_proposal");

  assert.deepEqual(grantsForUser(MEMBER, "primary"), [], "no refusal leaked access");
});

test("delegation does not extend to the constitution itself — roles and policies still need an amendment", async () => {
  await bootstrapDelegation();
  const steward = cookieFor(ADMIN);
  const addRole = await gov("/roles", steward, "POST", { name: "sneaky", capabilities: ["edit"] });
  assert.equal(addRole.status, 403);
  assert.equal((await body(addRole)).error, "requires_proposal");
});
