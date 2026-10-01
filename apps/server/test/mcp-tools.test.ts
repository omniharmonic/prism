/**
 * Prism MCP core note tools (Architecture v2 WP6.2). Every tool is implemented
 * through in-process gateway dispatch, so the permission matrix here is the
 * gateway's — these tests pin that nothing in the tool layer widens it:
 *
 *  - per-principal tools/list (owner / editor / viewer / create-only / no grants /
 *    read-only PAT / PAT bound to another vault);
 *  - call outcomes: visibility filtering, another user's private note, anti-
 *    escalation (tags), creator-only delete, create caps;
 *  - `if_updated_at` required (schema) and a 409 surfaced as a `conflict` tool
 *    error carrying the current updatedAt;
 *  - a content write / restore on a LIVE collab doc is refused, metadata is not;
 *  - version tools round trip; read PATs cannot reach write tools;
 *  - `prism://note/{id}` resource: Markdown for documents, respects view.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { db, addGrant, addVaultEntry, ensureUser } from "../src/db";
import { issuePat, issueInternalPat } from "../src/auth/pat";
import { createSession } from "../src/agent-sessions";
import { docNameFor, hocuspocus } from "../src/collab";
import { PRISM_TOOLS } from "../src/mcp/router";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
const VIEWER = "viewer@test.local";
const DROP = "drop@test.local";
const NONE = "none@test.local";
const OTHER = "someone-else@test.local";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  for (const e of [EDITOR, VIEWER, DROP, NONE, OTHER]) ensureUser(e);
  fv.tags = [
    { name: "garden", count: 4 },
    { name: "secret", count: 1 },
    { name: "dropbox", count: 0 },
  ];
  fv.put({ id: "g1", tags: ["garden"], path: "garden/a", content: "hello garden", updatedAt: "2026-02-01T00:00:00.000Z" });
  fv.put({ id: "g2", tags: ["garden"], path: "garden/b", content: "second hello", updatedAt: "2026-03-01T00:00:00.000Z" });
  fv.put({ id: "s1", tags: ["secret"], content: "hello secret" });
  fv.put({ id: "p1", tags: ["garden"], content: "hello private", metadata: { prism_creator: OTHER, prism_visibility: "private" } });
  fv.put({ id: "d1", tags: ["garden"], content: "<h1>Title</h1><p>Hello <strong>world</strong></p>" });
  fv.put({ id: "c1", tags: ["garden"], path: "garden/tool.ts", content: "export const x = 1;\n" });
  fv.put({ id: "mine", tags: ["garden"], content: "mine", metadata: { prism_creator: EDITOR } });
  grant(EDITOR, "tag", "garden", ["view", "comment", "suggest", "edit", "create"]);
  grant(VIEWER, "tag", "garden", ["view"]);
  grant(DROP, "tag", "dropbox", ["create"]);
});
afterEach(() => {
  hocuspocus.documents.delete(docNameFor("primary", "g1"));
  fv.restore();
});

function grant(email: string, type: "tag" | "note", resource: string, caps: string[], vaultId = "primary") {
  addGrant({ subject_type: "user", subject: email, resource_type: type, resource, level: "view", caps: caps as never, created_by: "test", vault_id: vaultId });
}

const tunnel = () => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip });
const pat = (email: string, scope: "read" | "write" = "write", vaultId = "primary") => issuePat({ email, vaultId, scope }).token;

async function connect(token: string): Promise<Client> {
  const headers: Record<string, string> = { ...tunnel(), authorization: `Bearer ${token}` };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}

type Out = { ok: true; data: any } | { ok: false; error: string; message?: string; detail?: unknown };
/** Normalize a tool call: success data, or the tool error / protocol error code. */
async function call(cl: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  try {
    const r: any = await cl.callTool({ name, arguments: args });
    if (r.isError) {
      const sc = r.structuredContent;
      return sc && typeof sc.error === "string" ? { ok: false, error: sc.error, message: sc.message, detail: sc.detail } : { ok: false, error: "protocol", message: JSON.stringify(r.content) };
    }
    return { ok: true, data: r.structuredContent };
  } catch (e) {
    return { ok: false, error: "protocol", message: String((e as Error).message) };
  }
}
// WP6.4 tools are pinned in mcp-governance.test.ts; this file pins the WP6.2 catalog.
const WP64 = new Set(["prism_governance_state", "prism_propose_change", "prism_vote", "prism_withdraw_proposal", "prism_note_access", "prism_share", "prism_dashboard_query"]);
const names = async (cl: Client) => (await cl.listTools()).tools.map((t) => t.name).filter((n) => !WP64.has(n)).sort();
const ids = (o: Out) => (o.ok ? (o.data.notes as Array<{ id: string }>).map((n) => n.id).sort() : []);
const must = (o: Out): any => {
  assert.ok(o.ok, `expected success, got ${JSON.stringify(o)}`);
  return (o as { data: any }).data;
};

const READ_TOOLS = [
  "prism_get_note",
  "prism_get_version",
  "prism_list_comments",
  "prism_list_tags",
  "prism_list_versions",
  "prism_query_notes",
  "prism_semantic_search",
  "prism_sheet_read",
  "prism_whoami",
];
const ALL_TOOLS = [
  ...READ_TOOLS,
  "prism_add_comment",
  "prism_create_note",
  "prism_delete_note",
  "prism_resolve_comment",
  "prism_restore_version",
  "prism_sheet_update",
  "prism_suggest_edit",
  "prism_update_note",
].sort();

// ── registry + tools/list matrix ────────────────────────────────────────────

test("every registered tool has matching scope/readOnlyHint and the catalog is complete", () => {
  assert.deepEqual(PRISM_TOOLS.map((t) => t.name).filter((n) => !WP64.has(n)).sort(), ALL_TOOLS);
  for (const t of PRISM_TOOLS) assert.equal(t.scope === "read", t.annotations.readOnlyHint, t.name);
  assert.equal(PRISM_TOOLS.find((t) => t.name === "prism_delete_note")!.annotations.destructiveHint, true);
});

test("tools/list per principal: owner all; editor all; viewer read-only tools; create-only just create; no grants nothing; read PAT reads", async () => {
  assert.deepEqual(await names(await connect(pat(OWNER))), ALL_TOOLS);
  assert.deepEqual(await names(await connect(pat(EDITOR))), ALL_TOOLS);
  assert.deepEqual(await names(await connect(pat(VIEWER))), READ_TOOLS);
  assert.deepEqual(await names(await connect(pat(DROP))), ["prism_create_note", "prism_whoami"]);
  assert.deepEqual(await names(await connect(pat(NONE))), ["prism_whoami"]);
  assert.deepEqual(await names(await connect(pat(EDITOR, "read"))), READ_TOOLS);
  assert.deepEqual(await names(await connect(pat(OWNER, "read"))), READ_TOOLS);
});

// ── reads ───────────────────────────────────────────────────────────────────

test("query_notes: a viewer/editor sees only granted notes, never another user's private note; tag/path/limit/search filters", async () => {
  const ed = await connect(pat(EDITOR));
  const all = ids(await call(ed, "prism_query_notes"));
  assert.deepEqual(all, ["c1", "d1", "g1", "g2", "mine"], "no secret, no someone-else's private");
  assert.deepEqual(ids(await call(ed, "prism_query_notes", { path_prefix: "garden/" })), ["c1", "g1", "g2"]);
  assert.deepEqual(ids(await call(ed, "prism_query_notes", { tag: "secret" })), []);
  const s = await call(ed, "prism_query_notes", { search: "hello" });
  assert.ok(!ids(s).includes("s1") && !ids(s).includes("p1"), "search never surfaces unviewable notes");
  assert.ok(ids(s).includes("g1"));
  const limited = must(await call(ed, "prism_query_notes", { limit: 2 }));
  assert.equal(limited.count, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.notes[0].id, "g2", "newest first");
  assert.deepEqual(limited.notes[0]._caps, ["view", "comment", "suggest", "edit", "create"]);
});

test("query_notes: owner sees everything (incl. private); content only on request and always truncated", async () => {
  fv.put({ id: "big", tags: ["garden"], content: "x".repeat(5000) });
  const ow = await connect(pat(OWNER));
  const lean = must(await call(ow, "prism_query_notes", { tag: "garden" }));
  assert.ok(lean.notes.some((n: any) => n.id === "p1"), "owner may see others' private notes (workspace owner)");
  assert.ok(lean.notes.every((n: any) => !("content" in n)), "no content unless asked");
  const withContent = must(await call(ow, "prism_query_notes", { tag: "garden", include_content: true }));
  const big = withContent.notes.find((n: any) => n.id === "big");
  assert.equal(big.content.length, 2000);
  assert.equal(big.contentLength, 5000);
  assert.equal(big.contentTruncated, true);
  const ed = await connect(pat(EDITOR));
  const edBig = must(await call(ed, "prism_query_notes", { include_content: true })).notes.find((n: any) => n.id === "big");
  assert.equal(edBig.content.length, 2000, "non-owner path is bounded the same way");
});

test("get_note: content + _caps + collab kind/live; viewer gets [view]; secret and another's private are forbidden", async () => {
  const ed = await connect(pat(EDITOR));
  const g1 = must(await call(ed, "prism_get_note", { id: "g1" }));
  assert.equal(g1.content, "hello garden");
  assert.deepEqual(g1._caps, ["view", "comment", "suggest", "edit", "create"]);
  assert.deepEqual(g1.collab, { kind: "document", live: false });
  assert.equal(must(await call(ed, "prism_get_note", { id: "c1" })).collab.kind, "code");

  hocuspocus.documents.set(docNameFor("primary", "g1"), {} as never);
  assert.equal(must(await call(ed, "prism_get_note", { id: "g1" })).collab.live, true);

  assert.equal((await call(ed, "prism_get_note", { id: "s1" })).ok, false);
  const priv = await call(ed, "prism_get_note", { id: "p1" });
  assert.ok(!priv.ok && priv.error === "forbidden");
  assert.deepEqual(must(await call(await connect(pat(VIEWER)), "prism_get_note", { id: "g1" }))._caps, ["view"]);
  const ow = must(await call(await connect(pat(OWNER)), "prism_get_note", { id: "s1" }));
  assert.ok(ow._caps.includes("delete") && ow._caps.includes("view"), "owner caps are computed, not absent");
  const missing = await call(ed, "prism_get_note", { id: "nope" });
  assert.ok(!missing.ok && missing.error === "not_found");
});

test("get_note bounds content at 100k characters", async () => {
  fv.put({ id: "huge", tags: ["garden"], content: "y".repeat(150_000) });
  const r = must(await call(await connect(pat(EDITOR)), "prism_get_note", { id: "huge" }));
  assert.equal(r.content.length, 100_000);
  assert.equal(r.contentLength, 150_000);
  assert.equal(r.contentTruncated, true);
});

test("list_tags: owner all, editor only granted tags", async () => {
  const ow = must(await call(await connect(pat(OWNER)), "prism_list_tags"));
  assert.deepEqual(ow.tags.map((t: any) => t.tag).sort(), ["dropbox", "garden", "secret"]);
  const ed = must(await call(await connect(pat(EDITOR)), "prism_list_tags"));
  assert.deepEqual(ed.tags.map((t: any) => t.tag), ["garden"]);
});

test("semantic_search: a PAT searches only its own vault", async () => {
  const ow = await call(await connect(pat(OWNER)), "prism_semantic_search", { query: "hello garden" });
  assert.ok(Array.isArray(must(ow).results));

  addVaultEntry({ id: "frb", label: "Front Range", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.putIn("frb", { id: "g1", content: "hello from the secondary garden", tags: ["garden"] });
  grant(EDITOR, "tag", "garden", ["view", "edit"], "frb");
  const other = await call(await connect(pat(EDITOR, "write", "frb")), "prism_semantic_search", { query: "hello" });
  assert.equal(must(other).results.length, 1);
  assert.equal(must(other).results[0].snippet, "hello from the secondary garden");
});

test("a PAT bound to another vault acts only in that vault", async () => {
  addVaultEntry({ id: "frb", label: "Front Range", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.putIn("frb", { id: "f1", tags: ["garden"], content: "frb note" });
  grant(EDITOR, "tag", "garden", ["view", "edit", "create"], "frb");
  const cl = await connect(pat(EDITOR, "write", "frb"));
  assert.deepEqual(ids(await call(cl, "prism_query_notes")), ["f1"], "primary notes are not visible");
  assert.equal((await call(cl, "prism_get_note", { id: "g1" })).ok, false, "a primary-vault id does not resolve");
  const created = must(await call(cl, "prism_create_note", { content: "in frb", tags: ["garden"] }));
  assert.ok(fv.addVault("frb").has(created.id));
  assert.ok(!fv.notes.has(created.id));
});

// ── writes ──────────────────────────────────────────────────────────────────

test("create_note: editor may create inside an editable tag, not outside; create-only holder may drop into its tag; viewer has no tool", async () => {
  const ed = await connect(pat(EDITOR));
  const made = must(await call(ed, "prism_create_note", { content: "fresh", tags: ["garden"], path: "garden/new" }));
  assert.equal(made.path, "garden/new");
  assert.deepEqual(made.tags, ["garden"]);
  assert.equal((fv.notes.get(made.id)!.metadata as any).prism_creator, EDITOR, "gateway stamps the creator");
  const out = await call(ed, "prism_create_note", { content: "x", tags: ["secret"] });
  assert.ok(!out.ok && out.error === "forbidden");
  const tagless = await call(ed, "prism_create_note", { content: "x", tags: [] });
  assert.ok(!tagless.ok && tagless.error === "forbidden", "a tagless note needs a whole-vault grant");

  const drop = await connect(pat(DROP));
  must(await call(drop, "prism_create_note", { content: "dropped", tags: ["dropbox"] }));
  assert.ok(!(await call(drop, "prism_create_note", { content: "x", tags: ["garden"] })).ok);
  assert.ok(!(await call(drop, "prism_get_note", { id: "g1" })).ok, "no view cap → the read tool is absent");

  const viewer = await connect(pat(VIEWER));
  assert.ok(!(await call(viewer, "prism_create_note", { content: "x", tags: ["garden"] })).ok);
});

test("update_note: if_updated_at is REQUIRED; content + metadata update; version captured", async () => {
  const ed = await connect(pat(EDITOR));
  const missing = await call(ed, "prism_update_note", { id: "g1", content: "no token" });
  assert.ok(!missing.ok, "schema rejects a call without if_updated_at");
  assert.equal(fv.notes.get("g1")!.content, "hello garden");

  const upd = must(await call(ed, "prism_update_note", { id: "g1", content: "edited", if_updated_at: "2026-02-01T00:00:00.000Z" }));
  assert.equal(fv.notes.get("g1")!.content, "edited");
  assert.notEqual(upd.updatedAt, "2026-02-01T00:00:00.000Z");
  const empty = await call(ed, "prism_update_note", { id: "g1", if_updated_at: upd.updatedAt });
  assert.ok(!empty.ok && empty.error === "invalid_request");
  // The PATCH sent to the vault carried the concurrency token.
  const patch = fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/notes/g1")).pop()!;
  assert.equal((patch.body as any).if_updated_at, "2026-02-01T00:00:00.000Z");
});

test("update_note: a stale if_updated_at (vault 409) surfaces as conflict with the current updatedAt, never the body", async () => {
  const ed = await connect(pat(EDITOR));
  fv.conflictOnNextWrite = true;
  const r = await call(ed, "prism_update_note", { id: "g1", content: "late", if_updated_at: "2000-01-01T00:00:00.000Z" });
  assert.ok(!r.ok && r.error === "conflict");
  assert.match(String(r.message), /re-read/);
  assert.deepEqual(r.detail, { id: "g1", updatedAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(fv.notes.get("g1")!.content, "hello garden");
  // Same for the owner passthrough.
  const ow = await connect(pat(OWNER));
  fv.conflictOnNextWrite = true;
  const r2 = await call(ow, "prism_update_note", { id: "g1", content: "late", if_updated_at: "2000-01-01T00:00:00.000Z" });
  assert.ok(!r2.ok && r2.error === "conflict");
});

test("update_note: anti-escalation and permission rules are the gateway's (editor cannot retag, viewer cannot write, other vault ids fail)", async () => {
  const ed = await connect(pat(EDITOR));
  const retag = await call(ed, "prism_update_note", { id: "g1", add_tags: ["garden/x"], if_updated_at: "2026-02-01T00:00:00.000Z" });
  assert.ok(!retag.ok && retag.error === "forbidden", "tag changes need organize");
  const secret = await call(ed, "prism_update_note", { id: "s1", content: "hijack", if_updated_at: "x" });
  assert.ok(!secret.ok && secret.error === "forbidden");
  assert.equal(fv.notes.get("s1")!.content, "hello secret");

  const viewer = await connect(pat(VIEWER));
  const v = await call(viewer, "prism_update_note", { id: "g1", content: "x", if_updated_at: "x" });
  assert.ok(!v.ok);
  assert.equal(fv.notes.get("g1")!.content, "hello garden");

  // organize holder may retag inside scope
  grant(VIEWER, "note", "g2", ["view", "edit", "organize"]);
  grant(VIEWER, "tag", "garden", ["view", "organize", "create"]);
  grant(VIEWER, "tag", "extra", ["view", "organize"]);
  const vw = await connect(pat(VIEWER));
  const ok = must(await call(vw, "prism_update_note", { id: "g2", add_tags: ["extra"], if_updated_at: "2026-03-01T00:00:00.000Z" }));
  assert.ok(ok.tags.includes("extra"));
});

test("update_note: the owner's tag changes use the vault dialect", async () => {
  const ow = await connect(pat(OWNER));
  const r = must(await call(ow, "prism_update_note", { id: "g1", add_tags: ["extra"], remove_tags: ["garden"], if_updated_at: "2026-02-01T00:00:00.000Z" }));
  assert.deepEqual(r.tags, ["extra"]);
});

test("LIVE collab doc: restores are refused; metadata/tag-only updates proceed (content writes merge — see mcp-collab.test.ts)", async () => {
  const ed = await connect(pat(EDITOR));
  hocuspocus.documents.set(docNameFor("primary", "g1"), {} as never);
  const restore = await call(ed, "prism_restore_version", { id: "g1", version_ix: 0, if_updated_at: "2026-02-01T00:00:00.000Z" });
  assert.ok(!restore.ok && restore.error === "conflict");
  assert.match(String(restore.message), /live collaborative editing/);
  assert.deepEqual(restore.detail, { live: true });
  assert.equal(fv.notes.get("g1")!.content, "hello garden");

  const meta = must(await call(ed, "prism_update_note", { id: "g1", metadata: { reviewed: true }, if_updated_at: "2026-02-01T00:00:00.000Z" }));
  assert.ok(meta.updatedAt);

  // liveness is not an oracle for people who cannot even view the note
  hocuspocus.documents.set(docNameFor("primary", "s1"), {} as never);
  try {
    const hidden = await call(ed, "prism_update_note", { id: "s1", content: "x", if_updated_at: "x" });
    assert.ok(!hidden.ok && hidden.error === "forbidden", "403 before any liveness answer");
  } finally {
    hocuspocus.documents.delete(docNameFor("primary", "s1"));
  }
  // and once the doc is unloaded the same write goes through
  hocuspocus.documents.delete(docNameFor("primary", "g1"));
  const cur = fv.notes.get("g1")!.updatedAt!;
  must(await call(ed, "prism_update_note", { id: "g1", content: "now fine", if_updated_at: cur }));
});

test("delete_note: creator with edit may; editor on someone else's note may not; delete-cap holder and owner may", async () => {
  const ed = await connect(pat(EDITOR));
  const denied = await call(ed, "prism_delete_note", { id: "g2" });
  assert.ok(!denied.ok && denied.error === "forbidden");
  assert.ok(fv.notes.has("g2"));
  must(await call(ed, "prism_delete_note", { id: "mine" }));
  assert.ok(!fv.notes.has("mine"));

  grant(VIEWER, "tag", "garden", ["view", "delete"]);
  must(await call(await connect(pat(VIEWER)), "prism_delete_note", { id: "g2" }));
  must(await call(await connect(pat(OWNER)), "prism_delete_note", { id: "c1" }));
  assert.ok(!fv.notes.has("c1"));
  const again = await call(await connect(pat(OWNER)), "prism_delete_note", { id: "c1" });
  assert.ok(!again.ok && again.error === "not_found");
});

test("a read-only PAT cannot call write tools by name (not listed, refused at call time, nothing written)", async () => {
  const rd = await connect(pat(EDITOR, "read"));
  for (const [name, args] of [
    ["prism_create_note", { content: "x", tags: ["garden"] }],
    ["prism_update_note", { id: "g1", content: "x", if_updated_at: "x" }],
    ["prism_delete_note", { id: "g1" }],
    ["prism_restore_version", { id: "g1", version_ix: 0, if_updated_at: "x" }],
  ] as const) {
    assert.equal((await call(rd, name, args as never)).ok, false, name);
  }
  assert.ok(fv.notes.has("g1"));
  assert.equal(fv.notes.get("g1")!.content, "hello garden");
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0, "no non-GET ever reached the vault");
  assert.ok(must(await call(rd, "prism_query_notes")).count > 0, "reads still work");
});

// ── versions ────────────────────────────────────────────────────────────────

test("version tools round trip: update twice → list → get → restore (if_updated_at required)", async () => {
  const ed = await connect(pat(EDITOR));
  const u1 = must(await call(ed, "prism_update_note", { id: "g1", content: "v2", if_updated_at: "2026-02-01T00:00:00.000Z" }));
  must(await call(ed, "prism_update_note", { id: "g1", content: "v3", if_updated_at: u1.updatedAt }));

  const list = must(await call(ed, "prism_list_versions", { id: "g1" }));
  assert.equal(list.total, 2);
  assert.ok(list.versions.every((v: any) => !("actor" in v) && !("via" in v) && !("content" in v)), "provenance and bodies are not in the list");
  const first = list.versions.find((v: any) => v.version_ix === 0);
  assert.ok(first);

  const v0 = must(await call(ed, "prism_get_version", { id: "g1", version_ix: 0 }));
  assert.equal(v0.content, "hello garden");

  const noToken = await call(ed, "prism_restore_version", { id: "g1", version_ix: 0 });
  assert.ok(!noToken.ok, "if_updated_at is required");
  assert.equal(fv.notes.get("g1")!.content, "v3");

  const stale = await call(ed, "prism_restore_version", { id: "g1", version_ix: 0, if_updated_at: "2000-01-01T00:00:00.000Z" });
  assert.ok(!stale.ok && stale.error === "conflict");
  assert.equal(fv.notes.get("g1")!.content, "v3");

  const cur = fv.notes.get("g1")!.updatedAt!;
  const restored = must(await call(ed, "prism_restore_version", { id: "g1", version_ix: 0, if_updated_at: cur }));
  assert.equal(restored.restoredFrom, 0);
  assert.equal(fv.notes.get("g1")!.content, "hello garden");
});

test("version tools honor view/edit: viewer reads history but cannot restore; no-view and private notes are refused", async () => {
  const ed = await connect(pat(EDITOR));
  must(await call(ed, "prism_update_note", { id: "g1", content: "v2", if_updated_at: "2026-02-01T00:00:00.000Z" }));
  const vw = await connect(pat(VIEWER));
  assert.equal(must(await call(vw, "prism_list_versions", { id: "g1" })).total, 1);
  assert.equal(must(await call(vw, "prism_get_version", { id: "g1", version_ix: 0 })).content, "hello garden");
  assert.ok(!(await call(vw, "prism_restore_version", { id: "g1", version_ix: 0, if_updated_at: fv.notes.get("g1")!.updatedAt! })).ok);
  assert.ok(!(await call(ed, "prism_list_versions", { id: "s1" })).ok);
  assert.ok(!(await call(ed, "prism_list_versions", { id: "p1" })).ok);
  // read-only PAT: history reads are reads
  assert.equal(must(await call(await connect(pat(EDITOR, "read")), "prism_list_versions", { id: "g1" })).total, 1);
});

// ── resource ────────────────────────────────────────────────────────────────

test("resource prism://note/{id}: Markdown for documents (HTML converted), raw for code, metadata + _caps; respects view", async () => {
  const vw = await connect(pat(VIEWER));
  const templates = await vw.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates.map((t) => t.uriTemplate).filter((u) => u.startsWith("prism://note")), ["prism://note/{id}"]);

  const doc = await vw.readResource({ uri: "prism://note/d1" });
  const body: any = doc.contents[0];
  assert.match(body.text, /^# Title/);
  assert.match(body.text, /\*\*world\*\*/);
  assert.equal(body.mimeType, "text/markdown");
  const meta = JSON.parse((doc.contents[1] as any).text);
  assert.deepEqual(meta._caps, ["view"]);
  assert.equal(meta.collab.kind, "document");
  assert.equal(meta.id, "d1");
  assert.ok(!("content" in meta), "body is not duplicated into the metadata block");

  const code: any = (await vw.readResource({ uri: "prism://note/c1" })).contents[0];
  assert.equal(code.text, "export const x = 1;\n");
  assert.equal(code.mimeType, "text/plain");
  const md: any = (await vw.readResource({ uri: "prism://note/g1" })).contents[0];
  assert.equal(md.text, "hello garden", "already-Markdown content is passed through");

  for (const id of ["s1", "p1", "nope"]) {
    await assert.rejects(vw.readResource({ uri: `prism://note/${id}` }), `${id} must not be readable`);
  }
  // A member with no grants has no resource at all; a read-only PAT still reads.
  assert.deepEqual((await (await connect(pat(NONE))).listResourceTemplates()).resourceTemplates.filter((t) => t.uriTemplate.startsWith("prism://note")), []);
  const rd: any = (await (await connect(pat(EDITOR, "read"))).readResource({ uri: "prism://note/g1" })).contents[0];
  assert.equal(rd.text, "hello garden");
});

test("unviewable and nonexistent resources fail identically (no existence oracle)", async () => {
  const vw = await connect(pat(VIEWER));
  const errs: string[] = [];
  for (const id of ["s1", "nope-404"]) {
    try {
      await vw.readResource({ uri: `prism://note/${id}` });
      errs.push("OK");
    } catch (e) {
      errs.push(String((e as Error).message).replace(id, "X"));
    }
  }
  assert.equal(errs[0], errs[1]);
  assert.notEqual(errs[0], "OK");
});


test("hosted suggest-only credential exposes suggestions but cannot directly modify a note through MCP", async () => {
  process.env.AGENT_PRISM_PROFILES = "true";
  let client: Client | undefined;
  try {
    const session = createSession({ vaultId: "primary", ownerEmail: OWNER, permissionMode: "suggest" });
    const turnId = "suggest-policy-test";
    db.prepare("INSERT INTO agent_turns (id, session_id, prompt, status, profile, permission_mode, policy_version) VALUES (?, ?, ?, 'running', 'prism-suggest', 'suggest', 1)").run(turnId, session.id, "Suggest a correction");
    const token = issueInternalPat({ email: OWNER, vaultId: "primary", scope: "write", turnId }).token;
    client = await connect(token);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("prism_suggest_edit"));
    assert.ok(names.includes("prism_get_note"));
    for (const name of ["prism_update_note", "prism_restore_version", "prism_create_note", "prism_share", "prism_vote", "prism_resolve_comment"]) assert.ok(!names.includes(name), name);
    const before = fv.notes.get("g1")!.content;
    const direct = await call(client, "prism_update_note", { id: "g1", content: "bypass attempt", if_updated_at: "2026-02-01T00:00:00.000Z" });
    assert.equal(direct.ok, false);
    assert.equal(fv.notes.get("g1")!.content, before);
    assert.equal((await call(client, "prism_get_note", { id: "g1" })).ok, true);
    db.prepare("UPDATE agent_sessions SET pending_mode = 'read-only' WHERE id = ?").run(session.id);
    assert.equal((await call(client, "prism_get_note", { id: "g1" })).ok, false, "a pending downgrade prevents new hosted calls");
  } finally { await client?.close(); delete process.env.AGENT_PRISM_PROFILES; }
});
