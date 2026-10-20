/**
 * The constitution in words — P3.
 *
 * Two claims under test. First, that the pure renderer really does turn a policy
 * into the sentence a member would say out loud (it is shared with the UI, so a
 * regression here is a regression in what the commons *reads*). Second, that the
 * server keeps the `governance-config` note's BODY in sync with the metadata that
 * governs — a constitution whose prose has drifted from its rules is worse than no
 * prose at all.
 *
 * Plus the "your access" endpoint, which is the only place a member can see WHY
 * they can edit something: a role compiled it, or a human shared it.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderConstitution,
  renderPolicySentence,
  renderRoleSentence,
  type ProsePolicy,
  type ProseState,
} from "@prism/core/governance-prose";
import { governance } from "../src/routes/governance";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const OWNER = "owner@test.local";
const cookieFor = (e: string) => sessionCookie(makeSession(e));

function jreq(path: string, cookie: string | undefined, method = "GET", payload?: unknown) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return governance.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: Response): Promise<any> => r.json();

const policy = (p: Partial<ProsePolicy>): ProsePolicy => ({
  action: "edit_note",
  scopeType: "global",
  scope: "",
  thresholdN: 1,
  quorum: 0,
  distinctRequired: true,
  eligibleRole: "gardener",
  windowSeconds: 0,
  autoPublish: false,
  ...p,
});

// ── the pure renderer ─────────────────────────────────────────────────────────

test("a policy renders as the sentence a member would say", () => {
  const s = renderPolicySentence(
    policy({ scopeType: "tag", scope: "medicine", thresholdN: 2, windowSeconds: 7 * 24 * 3600, autoPublish: true }),
  );
  assert.equal(
    s,
    "Edits to notes tagged #medicine need 2 approvals from Gardeners within 7 days, then go live immediately.",
  );
});

test("a global, staged policy says where it applies and that it awaits publishing", () => {
  const s = renderPolicySentence(policy({ thresholdN: 1 }));
  assert.equal(s, "Edits anywhere need 1 approval from Gardeners, then await publish by a publisher.");
});

test("an amendment policy names the constitution, not a scope", () => {
  const s = renderPolicySentence(policy({ action: "amend_governance", eligibleRole: "steward", thresholdN: 2 }));
  assert.match(s, /^Amendments to the constitution need 2 approvals from Stewards/);
});

test("a quorum clause appears only when there is a quorum", () => {
  assert.match(renderPolicySentence(policy({ quorum: 3 })), /at least 3 eligible voters taking part/);
  assert.doesNotMatch(renderPolicySentence(policy({ quorum: 0 })), /taking part/);
});

test("a role sentence names its capabilities, powers and scope", () => {
  const s = renderRoleSentence({
    name: "gardener",
    powers: ["publish"],
    scopeType: "tag",
    scope: "medicine",
    capabilities: ["view", "edit"],
    assigns: ["member"],
  });
  assert.equal(s, "Gardeners can read and edit existing notes within #medicine, may publish and staff Members.");
});

test("the constitution renders as markdown and never leaks an email", () => {
  const state: ProseState = {
    config: { enabled: true, bootstrapOwner: OWNER, amendPolicy: "p-amend", defaultThresholdN: 1, defaultEligibleRole: "steward" },
    roles: [{ id: "r1", name: "steward", powers: ["amend_governance"], scopeType: "global", scope: "", capabilities: ["view"], assigns: [] }],
    policies: [
      { id: "p-amend", ...policy({ action: "amend_governance", eligibleRole: "steward" }) },
      { id: "p-edit", ...policy({ scopeType: "tag", scope: "medicine", thresholdN: 2 }) },
    ],
    memberships: [{ subject: OWNER, role: "steward" }],
  };
  const md = renderConstitution(state);
  assert.match(md, /^# Governance Constitution/);
  assert.match(md, /Ratified and locked/);
  assert.match(md, /Edits to notes tagged #medicine need 2 approvals/);
  assert.match(md, /Stewards — 1 member/);
  assert.ok(!md.includes(OWNER), "the prose must not carry the roster's email addresses");
});

// ── the server keeps the config note's prose in sync ──────────────────────────

const configNote = () => [...fv.notes.values()].find((n) => (n.tags ?? []).includes("governance-config"));

test("a governance change regenerates the constitution note's body", async () => {
  const owner = cookieFor(OWNER);
  // Bootstrap enough to have a config note, then add a rule.
  assert.equal((await jreq("/roles", owner, "POST", { name: "gardener", powers: ["publish"], capabilities: ["view", "edit"] })).status, 200);
  assert.equal((await jreq("/config", owner, "POST", { bootstrapOwner: OWNER, defaultEligibleRole: "gardener" })).status, 200);

  const before = configNote();
  assert.ok(before, "bootstrapping should create the governance-config note");

  assert.equal(
    (
      await jreq("/policies", owner, "POST", {
        action: "edit_note",
        scopeType: "tag",
        scope: "medicine",
        thresholdN: 2,
        eligibleRole: "gardener",
        autoPublish: true,
      })
    ).status,
    200,
  );

  const after = configNote();
  assert.ok(after);
  assert.match(after.content, /# Governance Constitution/);
  assert.match(
    after.content,
    /Edits to notes tagged #medicine need 2 approvals from Gardeners, then go live immediately\./,
  );
  assert.match(after.content, /Gardeners can read and edit existing notes across the whole commons and may publish\./);
});

test("a role note carries its own sentence, not just a heading", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["publish"], capabilities: ["view", "edit"] });
  const roleNote = [...fv.notes.values()].find((n) => (n.tags ?? []).includes("governance-role"));
  assert.ok(roleNote);
  assert.match(roleNote.content, /# Governance role: gardener/);
  assert.match(roleNote.content, /Gardeners can read and edit existing notes/);
});

test("a policy note carries its own sentence", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/policies", owner, "POST", { action: "new_entry", thresholdN: 1, eligibleRole: "gardener" });
  const polNote = [...fv.notes.values()].find((n) => (n.tags ?? []).includes("governance-policy"));
  assert.ok(polNote);
  assert.match(polNote.content, /New entries anywhere need 1 approval from Gardeners/);
});

// ── GET /me ───────────────────────────────────────────────────────────────────

test("/me is unauthorized for anonymous callers", async () => {
  assert.equal((await jreq("/me", undefined)).status, 401);
});

test("/me reports the caller's powers, roles and governance-sourced grants", async () => {
  const owner = cookieFor(OWNER);
  const gardener = "g1@test.local";

  await jreq("/roles", owner, "POST", {
    name: "gardener",
    powers: ["publish"],
    scopeType: "tag",
    scope: "medicine",
    capabilities: ["view", "edit"],
  });
  await jreq("/roles", owner, "POST", { name: "steward", powers: ["amend_governance"], capabilities: ["view"] });
  const pol = await body(await jreq("/policies", owner, "POST", { action: "amend_governance", thresholdN: 1, eligibleRole: "steward" }));
  await jreq("/memberships", owner, "POST", { subject: gardener, role: "gardener" });
  await jreq("/memberships", owner, "POST", { subject: OWNER, role: "steward" });
  assert.equal(
    (await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, amendPolicy: pol.note.id, defaultEligibleRole: "steward" }))
      .status,
    200,
  );

  const mine = await body(await jreq("/me", cookieFor(gardener)));
  assert.deepEqual(mine.powers, ["publish"]);
  assert.equal(mine.memberships.length, 1);
  assert.equal(mine.memberships[0].role, "gardener");

  const tagGrant = mine.grants.find((g: { resource: string }) => g.resource === "medicine");
  assert.ok(tagGrant, "the ratified constitution should have compiled a #medicine grant");
  assert.deepEqual([...tagGrant.caps].sort(), ["edit", "view"]);
  assert.match(tagGrant.source, /^governance:/);
});

test("/me never returns another subject's grants", async () => {
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: [], capabilities: ["view", "edit"] });
  const pol = await body(await jreq("/policies", owner, "POST", { action: "amend_governance", thresholdN: 1, eligibleRole: "gardener" }));
  await jreq("/memberships", owner, "POST", { subject: "someone@test.local", role: "gardener" });
  await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, amendPolicy: pol.note.id, defaultEligibleRole: "gardener" });

  const stranger = await body(await jreq("/me", cookieFor("stranger@test.local")));
  assert.deepEqual(stranger.grants, []);
  assert.deepEqual(stranger.memberships, []);
  assert.deepEqual(stranger.powers, []);
});
