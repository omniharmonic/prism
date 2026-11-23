/**
 * Prism MCP governance, sharing, dashboard, prompts and resources (WP6.4). All
 * through the real /mcp endpoint, with the governance integrity layer ON (a test
 * GOVERNANCE_SIGNING_SECRET), so these pin that the tool layer adds no authority:
 *
 *  - propose → vote → vote → applied, end to end, by three different PATs;
 *  - an ineligible voter is refused; constitutional (amend_governance) proposals
 *    cannot be voted on through MCP; only the proposer may withdraw;
 *  - share: escalation denied, a non-account email refused (for the OWNER too),
 *    a subset share works, and share-link URLs never leak from note_access;
 *  - the /acl dispatch allowlist: only the five share routes are reachable;
 *  - dashboard_query counts only notes the caller may view;
 *  - a read PAT cannot see or call any write tool; prompts + resources work.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { addGrant, ensureUser, grantsForResource, setAccount } from "../src/db";
import { issuePat } from "../src/auth/pat";
import { setGovernanceSigningSecret } from "../src/governance-integrity";
import { governance } from "../src/routes/governance";
import { dispatchShareAsActor, safeSharePath } from "../src/mcp/dispatch";
import { PRISM_TOOLS } from "../src/mcp/router";
import { installFakeVault, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const SECRET = "test-governance-signing-secret-0123456789abcdef";
const OWNER = "owner@test.local";
const G1 = "g1@test.local";
const G2 = "g2@test.local";
const PROPOSER = "proposer@test.local"; // standing via a view grant; NOT a gardener
const EDITOR = "editor@test.local"; // edit + share on #garden
const VIEWER = "viewer@test.local";
const FRIEND = "friend@test.local"; // has a real account
const STRANGER = "stranger-no-account@test.local";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;

function grant(email: string, type: "tag" | "note", resource: string, caps: string[]) {
  addGrant({ subject_type: "user", subject: email, resource_type: type, resource, level: "view", caps: caps as never, created_by: "test", vault_id: "primary" });
}

const cookieFor = (e: string) => sessionCookie(makeSession(e));
function jreq(path: string, cookie: string, method = "GET", payload?: unknown) {
  const headers = new Headers({ cookie, "content-type": "application/json" });
  return governance.request(path, { method, headers, body: payload !== undefined ? JSON.stringify(payload) : undefined });
}

beforeEach(async () => {
  resetDb();
  fv = installFakeVault();
  setGovernanceSigningSecret(SECRET);
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  for (const e of [G1, G2, PROPOSER, EDITOR, VIEWER]) ensureUser(e);
  setAccount(FRIEND, "Friend", "x"); // a real (password) account
  ensureUser(STRANGER); // a bare row: NO password => no account
  fv.tags = [
    { name: "medicine", count: 2 },
    { name: "garden", count: 2 },
    { name: "secret", count: 1 },
  ];
  fv.put({ id: "n_med", content: "old", tags: ["medicine"], path: "med/a", updatedAt: "2026-02-01T00:00:00.000Z" });
  fv.put({ id: "g1n", tags: ["garden"], content: "garden one", metadata: { status: "open" } });
  fv.put({ id: "g2n", tags: ["garden"], content: "garden two", metadata: { status: "done" } });
  fv.put({ id: "s1", tags: ["secret"], content: "hidden", metadata: { status: "open" } });
  fv.put({ id: "priv", tags: ["garden"], content: "x", metadata: { prism_creator: "someone@else.local", prism_visibility: "private", status: "open" } });
  fv.put({
    id: "dash1",
    tags: ["dashboard"],
    content: "",
    metadata: {
      layout: {
        widgets: [
          { id: "w-count", type: "stat", title: "All", source: { tags: ["garden"] } },
          { id: "w-open", type: "stat", title: "Open", source: { tags: ["garden"] }, aggregateType: "count-where", aggregateCondition: { status: "open" } },
          { id: "w-list", type: "list", title: "Garden", source: { tags: ["garden"] }, sort: { field: "path", direction: "asc" }, columns: [{ field: "status" }] },
        ],
      },
    },
  });
  grant(PROPOSER, "tag", "medicine", ["view"]);
  grant(EDITOR, "tag", "garden", ["view", "comment", "suggest", "edit", "create", "share"]);
  grant(VIEWER, "tag", "garden", ["view"]);
  grant(VIEWER, "note", "dash1", ["view"]);
  grant(EDITOR, "note", "dash1", ["view"]);

  // A ratified commons, bootstrapped THROUGH THE ROUTES (so every note is signed).
  const owner = cookieFor(OWNER);
  await jreq("/roles", owner, "POST", { name: "gardener", powers: ["publish"], scopeType: "tag", scope: "medicine" });
  await jreq("/policies", owner, "POST", { action: "edit_note", scopeType: "tag", scope: "medicine", thresholdN: 2, distinctRequired: true, eligibleRole: "gardener", autoPublish: true });
  for (const g of [G1, G2]) await jreq("/memberships", owner, "POST", { subject: g, role: "gardener" });
  const cfg = await jreq("/config", owner, "POST", { enabled: true, bootstrapOwner: OWNER, defaultEligibleRole: "gardener" });
  assert.equal(cfg.status, 200);
});
afterEach(() => {
  setGovernanceSigningSecret(undefined);
  fv.restore();
});

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
const pat = (email: string, scope: "read" | "write" = "write") => issuePat({ email, vaultId: "primary", scope }).token;

async function connect(token: string): Promise<Client> {
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries({ ...tunnel(), authorization: `Bearer ${token}` })) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}

type Out = { ok: true; data: any } | { ok: false; error: string; message?: string };
async function call(cl: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  try {
    const r: any = await cl.callTool({ name, arguments: args });
    if (r.isError) {
      const sc = r.structuredContent;
      return sc && typeof sc.error === "string" ? { ok: false, error: sc.error, message: sc.message } : { ok: false, error: "protocol", message: JSON.stringify(r.content) };
    }
    return { ok: true, data: r.structuredContent };
  } catch (e) {
    return { ok: false, error: "protocol", message: String((e as Error).message) };
  }
}
const must = (o: Out): any => {
  assert.ok(o.ok, `expected success, got ${JSON.stringify(o)}`);
  return (o as { data: any }).data;
};
const WP64 = ["prism_dashboard_query", "prism_governance_state", "prism_note_access", "prism_propose_change", "prism_share", "prism_vote", "prism_withdraw_proposal"];
const toolNames = async (cl: Client) => (await cl.listTools()).tools.map((t) => t.name).filter((n) => WP64.includes(n)).sort();

// ── catalog ─────────────────────────────────────────────────────────────────

test("catalog: every WP6.4 tool is registered with matching scope/readOnlyHint; share is openWorld, never destructive", () => {
  const mine = PRISM_TOOLS.filter((t) => WP64.includes(t.name));
  assert.deepEqual(mine.map((t) => t.name).sort(), WP64);
  for (const t of mine) assert.equal(t.scope === "read", t.annotations.readOnlyHint, t.name);
  const share = mine.find((t) => t.name === "prism_share")!;
  assert.equal(share.annotations.openWorldHint, true);
  assert.notEqual(share.annotations.destructiveHint, true);
});

test("tools/list per principal; a read PAT sees and can call only read tools", async () => {
  assert.deepEqual(await toolNames(await connect(pat(OWNER))), WP64);
  assert.deepEqual(await toolNames(await connect(pat(EDITOR))), WP64);
  assert.deepEqual(await toolNames(await connect(pat(VIEWER))), ["prism_dashboard_query", "prism_governance_state", "prism_propose_change", "prism_vote", "prism_withdraw_proposal"]);
  const ro = await connect(pat(EDITOR, "read"));
  assert.deepEqual(await toolNames(ro), ["prism_dashboard_query", "prism_governance_state", "prism_note_access"]);
  for (const [name, args] of [
    ["prism_share", { id: "g1n", email: FRIEND, level: "view" }],
    ["prism_propose_change", { action: "edit_note", target: "n_med", content: "z", rationale: "r" }],
    ["prism_vote", { proposal_id: "x", vote: "approve" }],
    ["prism_withdraw_proposal", { proposal_id: "x" }],
  ] as const) {
    const r = await call(ro, name, args as never);
    assert.equal(r.ok, false, name);
  }
  assert.equal(grantsForResource("note", "g1n").length, 0, "the read PAT must not have written a grant");
  // a user with no grants, role or membership sees none of them; a governance-role-only holder (G1) does
  ensureUser("none@test.local");
  assert.deepEqual(await toolNames(await connect(pat("none@test.local"))), []);
  assert.deepEqual(await toolNames(await connect(pat(G1))), ["prism_governance_state", "prism_propose_change", "prism_vote", "prism_withdraw_proposal"]);
});

// ── governance e2e ──────────────────────────────────────────────────────────

test("propose → vote → vote → applied, through MCP, integrity ON", async () => {
  const proposer = await connect(pat(PROPOSER));
  const opened = must(await call(proposer, "prism_propose_change", { action: "edit_note", target: "n_med", content: "new text", rationale: "fixes a typo" }));
  assert.equal(opened.state, "open");
  const id = opened.proposal_id as string;

  const state = must(await call(proposer, "prism_governance_state"));
  assert.equal(state.enabled, true);
  assert.ok(state.openProposals.some((p: any) => p.id === id));

  // not applied, note unchanged
  assert.equal(fv.notes.get("n_med")!.content, "old");

  const v1 = must(await call(await connect(pat(G1)), "prism_vote", { proposal_id: id, vote: "approve", reason: "looks right" }));
  assert.equal(v1.outcome, "pending");
  assert.equal(v1.approvals, 1);
  assert.equal(fv.notes.get("n_med")!.content, "old");

  const v2 = must(await call(await connect(pat(G2)), "prism_vote", { proposal_id: id, vote: "approve" }));
  assert.equal(v2.outcome, "applied");
  assert.equal(fv.notes.get("n_med")!.content, "new text");

  // the rationale lived on the proposal, never on the note
  assert.equal(JSON.stringify(fv.notes.get("n_med")).includes("fixes a typo"), false);
});

test("a vote by an ineligible actor is refused and records nothing", async () => {
  const proposer = await connect(pat(PROPOSER));
  const id = must(await call(proposer, "prism_propose_change", { action: "edit_note", target: "n_med", content: "new", rationale: "r" })).proposal_id;
  const r = await call(proposer, "prism_vote", { proposal_id: id, vote: "approve" });
  assert.equal(r.ok, false);
  assert.equal((r as any).error, "forbidden");
  assert.match((r as any).message, /gardener/);
  // still needs two real approvals
  must(await call(await connect(pat(G1)), "prism_vote", { proposal_id: id, vote: "approve", apply: true }));
  assert.equal(fv.notes.get("n_med")!.content, "old");
});

test("propose needs a viewable target; a vote with apply=false only records", async () => {
  const proposer = await connect(pat(PROPOSER));
  const hidden = await call(proposer, "prism_propose_change", { action: "edit_note", target: "s1", content: "z", rationale: "r" });
  assert.equal((hidden as any).error, "not_found");
  const id = must(await call(proposer, "prism_propose_change", { action: "edit_note", target: "n_med", content: "new", rationale: "r" })).proposal_id;
  must(await call(await connect(pat(G1)), "prism_vote", { proposal_id: id, vote: "approve" }));
  const v = must(await call(await connect(pat(G2)), "prism_vote", { proposal_id: id, vote: "approve", apply: false }));
  assert.equal(v.outcome, "recorded");
  assert.equal(fv.notes.get("n_med")!.content, "old");
});

test("constitutional (amend_governance) proposals cannot be voted on through MCP", async () => {
  const owner = cookieFor(OWNER);
  const open = await jreq("/proposals", owner, "POST", { action: "amend_governance", payload: { kind: "set_config", config: { enabled: false } } });
  assert.equal(open.status, 201);
  const { id } = (await open.json()) as { id: string };
  const r = await call(await connect(pat(G1)), "prism_vote", { proposal_id: id, vote: "approve" });
  assert.equal((r as any).error, "forbidden");
  assert.match((r as any).message, /web app/);
});

test("only the proposer may withdraw", async () => {
  const proposer = await connect(pat(PROPOSER));
  const id = must(await call(proposer, "prism_propose_change", { action: "edit_note", target: "n_med", content: "new", rationale: "r" })).proposal_id;
  const other = await call(await connect(pat(G1)), "prism_withdraw_proposal", { proposal_id: id });
  assert.equal((other as any).error, "forbidden");
  // even the owner (proposer-only through MCP)
  assert.equal(((await call(await connect(pat(OWNER)), "prism_withdraw_proposal", { proposal_id: id })) as any).error, "forbidden");
  assert.equal(must(await call(proposer, "prism_withdraw_proposal", { proposal_id: id })).state, "withdrawn");
  // a withdrawn proposal is closed to votes
  assert.equal(((await call(await connect(pat(G1)), "prism_vote", { proposal_id: id, vote: "approve" })) as any).error, "conflict");
});

// ── sharing ─────────────────────────────────────────────────────────────────

test("share: a subset share to an existing account works; note_access shows it and never leaks link URLs", async () => {
  const ed = await connect(pat(EDITOR));
  const r = must(await call(ed, "prism_share", { id: "g1n", email: FRIEND, caps: ["view", "comment"] }));
  assert.equal(r.ok, true);
  assert.equal(r.inviteUrl, undefined);
  const grants = grantsForResource("note", "g1n").filter((g) => g.subject === FRIEND);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.created_by, EDITOR, "attributed to the human sharer");

  const access = must(await call(ed, "prism_note_access", { id: "g1n" }));
  assert.ok(access.people.some((p: any) => p.email === FRIEND));
  assert.equal(JSON.stringify(access).includes("?t="), false);

  // a tag share works too
  must(await call(ed, "prism_share", { tag: "garden", email: FRIEND, level: "view" }));
});

test("share escalation is denied (caps I do not hold); a view-only holder can neither share nor see the tool", async () => {
  const ed = await connect(pat(EDITOR));
  const r = await call(ed, "prism_share", { id: "g1n", email: FRIEND, caps: ["view", "delete"] });
  assert.equal((r as any).error, "forbidden");
  assert.match((r as any).message, /delete/);
  assert.equal(grantsForResource("note", "g1n").some((g) => g.subject === FRIEND), false);
  // share on a note OUTSIDE the tag I hold `share` on is refused by the acl gate
  const out = await call(ed, "prism_share", { id: "s1", email: FRIEND, level: "view" });
  assert.equal((out as any).error, "forbidden");
  const viewer = await connect(pat(VIEWER));
  assert.equal((await viewer.listTools()).tools.some((t) => t.name === "prism_share"), false);
});

test("share to an email with no account is refused — for the owner too (no invites via MCP)", async () => {
  for (const who of [EDITOR, OWNER]) {
    const r = await call(await connect(pat(who)), "prism_share", { id: "g1n", email: STRANGER, level: "view" });
    assert.equal((r as any).error, "invalid_request", who);
    assert.match((r as any).message, /no Prism account/);
  }
  assert.equal(grantsForResource("note", "g1n").some((g) => g.subject === STRANGER), false);
  // bad argument shapes
  const ed = await connect(pat(EDITOR));
  assert.equal(((await call(ed, "prism_share", { id: "g1n", tag: "garden", email: FRIEND, level: "view" })) as any).error, "invalid_request");
  assert.equal(((await call(ed, "prism_share", { id: "g1n", email: FRIEND })) as any).error, "invalid_request");
});

test("/acl allowlist: only the five share routes are reachable; everything else is refused before dispatch", async () => {
  const ok: Array<[string, string]> = [
    ["/acl/notes/g1n", "GET"],
    ["/acl/notes/g1n/people", "PUT"],
    ["/acl/notes/g1n/people/a%40b.c", "DELETE"],
    ["/acl/tags/garden/people", "PUT"],
    ["/acl/tags/garden/people/a%40b.c", "DELETE"],
  ];
  for (const [p, m] of ok) assert.equal(safeSharePath(p, m), p);
  const bad: Array<[string, string]> = [
    ["/acl/users", "GET"],
    ["/acl/members", "GET"],
    ["/acl/members", "PUT"],
    ["/acl/notes/g1n/links", "POST"],
    ["/acl/notes/g1n/visibility", "PUT"],
    ["/acl/notes/g1n/tags", "POST"],
    ["/acl/notes/g1n/mirror", "POST"],
    ["/acl/notes/g1n/people", "GET"], // wrong method
    ["/acl/notes/g1n", "DELETE"],
    ["/acl/tags/garden/access", "GET"],
    ["/acl/tags/garden/publish", "POST"],
    ["/acl/peers/pair", "POST"],
    ["/acl/vaults", "POST"],
    ["/acl/notes/../users", "GET"],
    ["/acl/notes/%2e%2e/people", "PUT"],
    ["/acl/notes/a%2Fb/people", "PUT"],
    ["/acl/notes/g1n?x=1", "GET"],
    ["/api/notes", "GET"],
    ["/auth/pats", "GET"],
    ["acl/notes/g1n", "GET"],
  ];
  for (const [p, m] of bad) assert.throws(() => safeSharePath(p, m), `${m} ${p}`);

  // and the dispatch function itself, as an OWNER principal, cannot reach admin /acl routes
  const owner = { actor: { kind: "user", email: OWNER, role: "owner", grants: [], vaultId: "primary" } as never, readOnly: false, credentialId: "t", via: "pat" } as never;
  await assert.rejects(() => dispatchShareAsActor(app, owner, "/acl/members", { method: "GET" }));
  await assert.rejects(() => dispatchShareAsActor(app, owner, "/acl/notes/g1n/links", { method: "POST", body: "{}" }));
  // a read-only principal may only GET even on an allowed route
  const ro = { ...(owner as object), readOnly: true } as never;
  await assert.rejects(() => dispatchShareAsActor(app, ro, "/acl/notes/g1n/people", { method: "PUT", body: "{}" }));
  assert.equal((await dispatchShareAsActor(app, ro, "/acl/notes/g1n", { method: "GET" })).status, 200);
});

// ── dashboard ───────────────────────────────────────────────────────────────

test("dashboard_query: a viewer's counts include only notes they may view (no secret, no other's private)", async () => {
  const viewer = await connect(pat(VIEWER));
  const r = must(await call(viewer, "prism_dashboard_query", { dashboard_id: "dash1" }));
  const byId = Object.fromEntries(r.widgets.map((w: any) => [w.widget, w]));
  assert.equal(byId["w-count"].value, 2, "g1n + g2n only — not priv, not s1");
  assert.equal(byId["w-open"].value, 1);
  assert.deepEqual(byId["w-list"].rows.map((x: any) => x.id).sort(), ["g1n", "g2n"]);
  assert.equal(byId["w-list"].rows[0].fields.status !== undefined, true);

  const one = must(await call(viewer, "prism_dashboard_query", { dashboard_id: "dash1", widget_id: "w-open" }));
  assert.equal(one.widgets.length, 1);

  // inline: a tag the viewer has no grant on yields nothing
  const hidden = must(await call(viewer, "prism_dashboard_query", { source: { tags: ["secret"] } }));
  assert.equal(hidden.widgets[0].total, 0);
  // inline aggregate over what they can see
  const agg = must(await call(viewer, "prism_dashboard_query", { source: { tags: ["garden"] }, aggregate: { type: "count" } }));
  assert.equal(agg.widgets[0].value, 2);
  // grouping
  const grouped = must(await call(viewer, "prism_dashboard_query", { source: { tags: ["garden"] }, group_by: "status" }));
  assert.deepEqual(grouped.widgets[0].groups.map((g: any) => g.key).sort(), ["done", "open"]);
});

test("dashboard_query: bad inputs are refused; a non-dashboard note is not runnable; the owner sees the wider set", async () => {
  const viewer = await connect(pat(VIEWER));
  assert.equal(((await call(viewer, "prism_dashboard_query", {})) as any).error, "invalid_request");
  assert.equal(((await call(viewer, "prism_dashboard_query", { dashboard_id: "g1n" })) as any).error, "invalid_request");
  assert.equal(((await call(viewer, "prism_dashboard_query", { dashboard_id: "s1" })) as any).error, "not_found");
  const owner = await connect(pat(OWNER, "read"));
  const r = must(await call(owner, "prism_dashboard_query", { source: { tags: ["secret"] }, aggregate: { type: "count" } }));
  assert.equal(r.widgets[0].value, 1);
});

// ── prompts + resources ─────────────────────────────────────────────────────

test("prompts: listed for a principal with standing; bodies adapt to the caller's caps", async () => {
  const ed = await connect(pat(EDITOR));
  const list = (await ed.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(list, ["edit-shared-doc", "review-open-proposals", "summarize-comments"]);

  const edit = await ed.getPrompt({ name: "edit-shared-doc", arguments: { id: "g1n" } });
  assert.match(JSON.stringify(edit.messages), /EDIT directly/);
  const viewer = await connect(pat(VIEWER));
  const ro = await viewer.getPrompt({ name: "edit-shared-doc", arguments: { id: "g1n" } });
  assert.match(JSON.stringify(ro.messages), /only READ/);

  const summ = await ed.getPrompt({ name: "summarize-comments", arguments: { id: "g1n" } });
  assert.match(JSON.stringify(summ.messages), /g1n/);

  const proposer = await connect(pat(PROPOSER));
  const id: string = must(await call(proposer, "prism_propose_change", { action: "edit_note", target: "n_med", content: "brand new body", rationale: "because" })).proposal_id;
  const rev = await (await connect(pat(G1))).getPrompt({ name: "review-open-proposals", arguments: {} });
  const text = JSON.stringify(rev.messages);
  assert.ok(text.includes(id));
  assert.match(text, /brand new body/);
  assert.match(text, /because/);

});

test("resources: constitution renders for members (no emails); prism://me describes the caller", async () => {
  ensureUser("none@test.local");
  const g1 = await connect(pat(G1));
  const c = await g1.readResource({ uri: "prism://governance/constitution" });
  const md = (c.contents[0] as { text: string }).text;
  assert.match(md, /Governance Constitution/);
  assert.equal(md.includes("@test.local"), false);

  const me = await g1.readResource({ uri: "prism://me" });
  const body = JSON.parse((me.contents[0] as { text: string }).text);
  assert.equal(body.email, G1);
  assert.equal(body.readOnly, false);

});
