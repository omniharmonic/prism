/**
 * P0 hardening of the governance subsystem — the properties that keep a locked
 * commons from bricking or drowning itself. Full-stack through the real Hono
 * `governance` app + the fake vault, in the same shape as governance-route.test.ts.
 *
 * Four families:
 *  - LIFECYCLE: update/remove for roles, policies and memberships (not just adds),
 *    with the cascade + the refusals that keep governance amendable.
 *  - IDEMPOTENCE: re-running a bootstrap converges instead of duplicating the
 *    constitution (the `commons-init` duplication bug).
 *  - RATIFICATION: the one-way latch refuses a constitution that could never
 *    amend itself, and a `{enabled:false}` amendment cannot blank the recovery root.
 *  - PARTICIPATION: standing to propose, mutable votes, and window auto-close.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { governance } from "../src/routes/governance";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
import { addGrant, setMembership } from "../src/db";
import { GOV_TAGS } from "../src/governance-store";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const A1 = "a1@test.local";
const A2 = "a2@test.local";
const STRANGER = "stranger@test.local";
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

/** Bootstrap an enabled commons: `admin` role, an amend policy, admins, lock. */
async function bootstrap(opts: { thresholdN?: number; windowSeconds?: number; admins?: string[] } = {}) {
  const owner = cookieFor(OWNER);
  const admins = opts.admins ?? [A1];
  await jreq("/roles", owner, "POST", { name: "admin", powers: ["amend_governance", "review"] });
  const pol = await body(
    await jreq("/policies", owner, "POST", {
      action: "amend_governance",
      thresholdN: opts.thresholdN ?? 1,
      distinctRequired: true,
      eligibleRole: "admin",
      windowSeconds: opts.windowSeconds ?? 0,
    }),
  );
  for (const a of admins) await jreq("/memberships", owner, "POST", { subject: a, role: "admin" });
  const cfg = await jreq("/config", owner, "POST", {
    enabled: true,
    bootstrapOwner: OWNER,
    amendPolicy: pol.note.id,
    defaultEligibleRole: "admin",
  });
  assert.equal(cfg.status, 200, "bootstrap config must ratify");
  return pol.note.id as string;
}

/** Open → approve (by every listed admin) → apply an amendment. Returns the response. */
async function amend(change: unknown, voters: string[] = [A1]): Promise<Response> {
  const open = await jreq("/proposals", cookieFor(voters[0] ?? A1), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify(change),
  });
  assert.equal(open.status, 201);
  const { id } = await body(open);
  for (const v of voters) {
    assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor(v), "POST", { vote: "approve" })).status, 200);
  }
  return jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST");
}

const state = async () => body(await jreq("/state", cookieFor(OWNER)));

// ── lifecycle: the missing half of every axis ─────────────────────────────────

test("update_role merges fields into the existing role note (no duplicate)", async () => {
  await bootstrap();
  const before = (await state()).roles.find((r: { name: string }) => r.name === "admin");

  const res = await amend({ kind: "update_role", ref: "admin", role: { powers: ["amend_governance", "publish"] } });
  assert.equal(res.status, 200);

  const roles = (await state()).roles;
  assert.equal(roles.filter((r: { name: string }) => r.name === "admin").length, 1);
  const after = roles.find((r: { name: string }) => r.name === "admin");
  assert.equal(after.id, before.id, "the same note is rewritten");
  assert.deepEqual([...after.powers].sort(), ["amend_governance", "publish"]);
});

test("remove_role deletes the role AND cascades to its memberships", async () => {
  await bootstrap({ admins: [A1, A2] });
  // a second role whose removal we can observe without disarming the amend path
  assert.equal((await amend({ kind: "add_role", role: { name: "gardener", powers: ["review"] } })).status, 200);
  assert.equal((await amend({ kind: "add_membership", membership: { subject: A2, role: "gardener" } })).status, 200);
  assert.equal((await body(await jreq("/memberships", cookieFor(OWNER)))).memberships.length, 3);

  assert.equal((await amend({ kind: "remove_role", ref: "gardener" })).status, 200);

  const s = await state();
  assert.ok(!s.roles.some((r: { name: string }) => r.name === "gardener"));
  const roster = (await body(await jreq("/memberships", cookieFor(OWNER)))).memberships;
  assert.ok(!roster.some((m: { role: string }) => m.role === "gardener"), "dangling memberships are cascaded away");
  assert.equal(roster.length, 2, "the admin memberships survive");
});

test("remove_membership revokes exactly one (subject, role) binding", async () => {
  await bootstrap({ admins: [A1, A2] });
  assert.equal((await amend({ kind: "remove_membership", subject: A2, role: "admin" })).status, 200);
  const roster = (await body(await jreq("/memberships", cookieFor(OWNER)))).memberships;
  assert.deepEqual(roster.map((m: { subject: string }) => m.subject), [A1]);
});

test("update_policy rewrites the policy in place", async () => {
  const amendPolicy = await bootstrap();
  const res = await amend({ kind: "update_policy", ref: amendPolicy, policy: { thresholdN: 3, quorum: 2 } });
  assert.equal(res.status, 200);
  const p = (await state()).policies.find((x: { id: string }) => x.id === amendPolicy);
  assert.equal(p.thresholdN, 3);
  assert.equal(p.quorum, 2);
  assert.equal(p.action, "amend_governance", "unspecified fields are preserved");
});

test("the amend policy cannot be deleted, or retargeted away from amend_governance", async () => {
  const amendPolicy = await bootstrap();

  const del = await amend({ kind: "remove_policy", ref: amendPolicy });
  assert.equal(del.status, 400);
  assert.equal((await body(del)).error, "invalid_config");

  const retarget = await amend({ kind: "update_policy", ref: amendPolicy, policy: { action: "edit_note" } });
  assert.equal(retarget.status, 400);
  assert.equal((await body(retarget)).error, "invalid_config");

  // still there, still governing
  assert.ok((await state()).policies.some((p: { id: string }) => p.id === amendPolicy));
});

test("a non-constitutional policy can be removed", async () => {
  await bootstrap();
  assert.equal(
    (await amend({ kind: "add_policy", policy: { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, eligibleRole: "admin" } })).status,
    200,
  );
  const target = (await state()).policies.find((p: { action: string }) => p.action === "edit_note");
  assert.equal((await amend({ kind: "remove_policy", ref: target.id })).status, 200);
  assert.ok(!(await state()).policies.some((p: { action: string }) => p.action === "edit_note"));
});

test("update/remove of an unknown ref is a structured 404, not a crash", async () => {
  await bootstrap();
  for (const change of [
    { kind: "update_role", ref: "ghost", role: { scope: "x" } },
    { kind: "remove_role", ref: "ghost" },
    { kind: "update_policy", ref: "ghost", policy: { thresholdN: 2 } },
    { kind: "remove_policy", ref: "ghost" },
    { kind: "remove_membership", subject: "ghost@test.local", role: "admin" },
  ]) {
    const r = await amend(change);
    assert.equal(r.status, 404, `${change.kind} on a missing ref → 404`);
    assert.equal((await body(r)).error, "not_found");
  }
});

// ── idempotence: re-running a bootstrap converges ─────────────────────────────

test("add_role / add_policy / add_membership are UPSERTS — a replayed bootstrap does not duplicate", async () => {
  const owner = cookieFor(OWNER);
  const seed = async () => {
    await jreq("/roles", owner, "POST", { name: "gardener", powers: ["review"] });
    await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, eligibleRole: "gardener" });
    await jreq("/memberships", owner, "POST", { subject: A1, role: "gardener" });
  };
  await seed();
  await seed();
  await seed();

  assert.equal(notesTagged(GOV_TAGS.role).length, 1);
  assert.equal(notesTagged(GOV_TAGS.policy).length, 1);
  assert.equal(notesTagged(GOV_TAGS.membership).length, 1);

  // and the LAST write wins on the surviving note
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["invite", "publish"] });
  const role = (await state()).roles.find((r: { name: string }) => r.name === "gardener");
  assert.deepEqual([...role.powers].sort(), ["invite", "publish"]);
  assert.equal(notesTagged(GOV_TAGS.role).length, 1);
});

test("a policy with a DIFFERENT scope is a new policy, not an upsert", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2 });
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "water", thresholdN: 2 });
  assert.equal(notesTagged(GOV_TAGS.policy).length, 2);
});

// ── ratification pre-flight ───────────────────────────────────────────────────

test("ratifying an un-amendable constitution is refused (the latch is one-way)", async () => {
  const owner = cookieFor(OWNER);

  // nothing configured at all
  const bare = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER });
  assert.equal(bare.status, 400);
  assert.equal((await body(bare)).error, "invalid_config");
  assert.equal((await state()).enabled, false, "the commons stays unlocked");

  // a role exists but nobody holds it → the threshold could never be met
  await jreq("/roles", owner, "POST", { name: "admin", powers: ["amend_governance"] });
  const empty = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, defaultEligibleRole: "admin" });
  assert.equal(empty.status, 400);
  assert.match((await body(empty)).detail, /un-amendable/);

  // an amendPolicy that names nothing
  await jreq("/memberships", owner, "POST", { subject: A1, role: "admin" });
  const ghost = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, amendPolicy: "nope", defaultEligibleRole: "admin" });
  assert.equal(ghost.status, 400);

  // with a real amend policy and a real member → ratifies
  const ok = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, defaultEligibleRole: "admin" });
  assert.equal(ok.status, 200);
  assert.equal((await state()).locked, true);
});

test("a {enabled:false} amendment cannot blank the bootstrapOwner (re-bootstrap survives)", async () => {
  await bootstrap();
  // exactly the payload the UI's "disable governance" template sends
  const res = await amend({ kind: "set_config", config: { enabled: false } });
  assert.equal(res.status, 200);

  const s = await state();
  assert.equal(s.enabled, false);
  assert.equal(s.locked, false);
  assert.equal(s.config.bootstrapOwner, OWNER, "the recovery root is preserved");
  assert.equal(s.isBootstrapOwner, true);

  // and the owner can therefore configure again
  assert.equal((await jreq("/roles", cookieFor(OWNER), "POST", { name: "gardener", powers: ["review"] })).status, 200);
});

test("an amendment that keeps governance enabled is not re-ratified (locked → locked)", async () => {
  const amendPolicy = await bootstrap();
  // A locked amendment raising the threshold beyond the current membership would
  // fail a fresh ratification check — but it already passed one, so it applies.
  const res = await amend({
    kind: "set_config",
    config: { enabled: true, bootstrapOwner: OWNER, amendPolicy, defaultEligibleRole: "admin", defaultThresholdN: 9 },
  });
  assert.equal(res.status, 200);
  assert.equal((await state()).config.defaultThresholdN, 9);
});

// ── standing to propose ───────────────────────────────────────────────────────

test("a signed-in stranger with no grants and no role has no standing to propose", async () => {
  await bootstrap();
  const stranger = cookieFor(STRANGER);

  const gov = await jreq("/proposals", stranger, "POST", { action: "amend_governance", target: "governance", payload: "{}" });
  assert.equal(gov.status, 403);
  assert.equal((await body(gov)).error, "no_standing");

  const content = await jreq("/content/propose", stranger, "POST", { action: "new_entry", tags: ["medicine"], content: "spam" });
  assert.equal(content.status, 403);
  assert.equal((await body(content)).error, "no_standing");

  // …and nothing was written
  assert.equal(notesTagged(GOV_TAGS.proposal).length, 0);
});

test("standing comes from a workspace role, a governance membership, or any grant", async () => {
  await bootstrap();
  const propose = (who: string) =>
    jreq("/proposals", cookieFor(who), "POST", { action: "amend_governance", target: "governance", payload: "{}" });

  // (a) workspace member
  setMembership("primary", "member@test.local", "member", OWNER);
  assert.equal((await propose("member@test.local")).status, 201);
  // (b) governance role holder
  assert.equal((await propose(A1)).status, 201);
  // (c) holder of a single grant in this vault
  grantUser("guest@test.local", "tag", "medicine", "view");
  assert.equal((await propose("guest@test.local")).status, 201);
});

test("an `anyone` grant (public publication) does NOT confer standing", async () => {
  await bootstrap();
  // Publishing a tag creates an anyone/view grant that grantsForUser attaches to
  // EVERY request in the vault — if that counted as standing, any public site
  // would open the proposal queue to all signed-in strangers.
  addGrant({ subject_type: "anyone", subject: "", resource_type: "tag", resource: "medicine", level: "view", created_by: "test" });
  const r = await jreq("/proposals", cookieFor("stranger2@test.local"), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: "{}",
  });
  assert.equal(r.status, 403);
  assert.equal((await body(r)).error, "no_standing");
});

// ── mutable votes ─────────────────────────────────────────────────────────────

test("changing a vote changes the tally (approve → reject un-approves)", async () => {
  await bootstrap({ thresholdN: 2, admins: [A1, A2] });
  const open = await jreq("/proposals", cookieFor(A1), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify({ kind: "add_role", role: { name: "gardener", powers: ["review"] } }),
  });
  const { id } = await body(open);

  await jreq(`/proposals/${id}/vote`, cookieFor(A1), "POST", { vote: "approve" });
  await jreq(`/proposals/${id}/vote`, cookieFor(A2), "POST", { vote: "approve" });
  let ev = (await body(await jreq(`/proposals/${id}`, cookieFor(OWNER)))).evaluation;
  assert.equal(ev.approvals, 2);
  assert.equal(ev.satisfied, true);

  // A1 reconsiders — one vote note, one fewer approval, threshold no longer met
  const changed = await jreq(`/proposals/${id}/vote`, cookieFor(A1), "POST", { vote: "reject", reason: "on reflection" });
  assert.equal(changed.status, 200);
  assert.equal((await body(changed)).updated, true);
  assert.equal(notesTagged(GOV_TAGS.vote).length, 2, "a changed vote does not stack a second note");

  ev = (await body(await jreq(`/proposals/${id}`, cookieFor(OWNER)))).evaluation;
  assert.equal(ev.approvals, 1);
  assert.equal(ev.satisfied, false);
  assert.equal((await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST")).status, 409);
});

// ── window auto-close ─────────────────────────────────────────────────────────

/** Backdate a proposal (and optionally its votes) so its window has closed. */
function backdate(proposalId: string, minutesAgo: number, voteOffsetSeconds?: number) {
  const p = fv.notes.get(proposalId)!;
  const opened = new Date(Date.now() - minutesAgo * 60_000);
  p.metadata = { ...(p.metadata ?? {}), opened_at: opened.toISOString() };
  if (voteOffsetSeconds !== undefined) {
    for (const n of notesTagged(GOV_TAGS.vote)) {
      if (n.metadata?.proposal !== proposalId) continue;
      n.metadata = { ...n.metadata, at: new Date(opened.getTime() + voteOffsetSeconds * 1000).toISOString() };
    }
  }
}

async function openAmendment(): Promise<string> {
  const open = await jreq("/proposals", cookieFor(A1), "POST", {
    action: "amend_governance",
    target: "governance",
    payload: JSON.stringify({ kind: "add_role", role: { name: "gardener", powers: ["review"] } }),
  });
  return (await body(open)).id as string;
}

const proposalState = async (id: string) => (await body(await jreq(`/proposals/${id}`, cookieFor(OWNER)))).proposal.state;

test("voting after the window closes rejects the proposal", async () => {
  await bootstrap({ windowSeconds: 60 });
  const id = await openAmendment();
  backdate(id, 10);

  const late = await jreq(`/proposals/${id}/vote`, cookieFor(A1), "POST", { vote: "approve" });
  assert.equal(late.status, 409);
  assert.equal((await body(late)).error, "window_expired");
  assert.equal(await proposalState(id), "rejected");
  assert.equal(notesTagged(GOV_TAGS.vote).length, 0, "no vote is recorded after the window");
});

test("applying an expired proposal that never gathered its approvals rejects it", async () => {
  await bootstrap({ windowSeconds: 60 });
  const id = await openAmendment();
  backdate(id, 10);

  const res = await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST");
  assert.equal(res.status, 409);
  const b = await body(res);
  assert.equal(b.error, "window_expired");
  assert.ok(b.evaluation, "the failed evaluation is returned for legibility");
  assert.equal(await proposalState(id), "rejected");
  assert.ok(!(await state()).roles.some((r: { name: string }) => r.name === "gardener"));
});

test("approvals that landed IN the window still apply, however late the apply is", async () => {
  await bootstrap({ windowSeconds: 60 });
  const id = await openAmendment();
  assert.equal((await jreq(`/proposals/${id}/vote`, cookieFor(A1), "POST", { vote: "approve" })).status, 200);
  // the vote was cast 1s after opening; the apply comes 10 minutes later
  backdate(id, 10, 1);

  const res = await jreq(`/proposals/${id}/apply`, cookieFor(OWNER), "POST");
  assert.equal(res.status, 200);
  assert.equal(await proposalState(id), "applied");
  assert.ok((await state()).roles.some((r: { name: string }) => r.name === "gardener"));
});

// ── pre-lock fixup REST surface (PATCH/DELETE, same choke point) ──────────────

test("pre-lock, the bootstrap owner can PATCH and DELETE roles/policies/memberships directly", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardner", powers: ["review"] }); // typo'd on purpose
  await jreq("/memberships", owner, "POST", { subject: A1, role: "gardner" });
  const pol = await body(await jreq("/policies", owner, "POST", { action: "edit_note", thresholdN: 2, eligibleRole: "gardner" }));

  // fix the typo'd name and retune the policy
  assert.equal((await jreq("/roles/gardner", owner, "PATCH", { name: "gardener" })).status, 200);
  assert.equal((await jreq(`/policies/${pol.note.id}`, owner, "PATCH", { thresholdN: 3 })).status, 200);
  const st = await state();
  assert.equal(st.roles[0].name, "gardener");
  assert.equal(st.policies[0].thresholdN, 3);

  // remove the membership, then the role and policy entirely
  assert.equal((await jreq("/memberships", owner, "DELETE", { subject: A1, role: "gardner" })).status, 200);
  assert.equal((await jreq("/roles/gardener", owner, "DELETE")).status, 200);
  assert.equal((await jreq(`/policies/${pol.note.id}`, owner, "DELETE")).status, 200);
  const after = await state();
  assert.equal(after.roles.length, 0);
  assert.equal(after.policies.length, 0);
  assert.equal((await body(await jreq("/memberships", owner))).memberships.length, 0);

  // unknown refs are structured 404s
  assert.equal((await jreq("/roles/nope", owner, "DELETE")).status, 404);
});

test("pre-lock fixups are bootstrap-owner-only; post-lock they demand an amendment", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["review"] });
  const r = await jreq("/roles/gardener", cookieFor(STRANGER), "PATCH", { name: "weeder" });
  assert.equal(r.status, 403);

  await bootstrap();
  const locked = await jreq("/roles/gardener", owner, "DELETE");
  assert.equal(locked.status, 403);
  assert.equal((await body(locked)).error, "requires_proposal");
});
