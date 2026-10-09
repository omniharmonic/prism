/**
 * Review fixes for wave 2C (database depth): H1 writer-stamp exposure, H2 ReDoS,
 * M1 keyed CSV re-import, M4 passthrough stamping, L1/L2/L3.
 */
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { publish } from "../src/routes/publish";
import { db, createPublication, addGrant } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { stampJsonBody, writerIdFor, resolveWriter, WRITER_KEY, WRITER_AT_KEY } from "../src/writer-stamp";
import { serializeNoteMarkdown } from "../src/worker/github-dir";
import { syncMirror, type MirrorVault } from "../src/worker/vault-mirror";
import { runQuery, matchesSearch, parseCsv, toCsv, coerceCsvValue, compareValues, evaluateCondition, safeTitleLeaf, looksLikeEmail, linkLabel, inferKind } from "@prism/core/database";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
let innerFetch: typeof fetch;
const vaultTags = () => [
  { name: "task", count: 4, description: "Work", fields: { status: { type: "string", enum: ["todo", "doing", "done"] }, points: { type: "number" } } },
];

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") return Response.json(vaultTags());
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
});
afterEach(() => {
  setSchemaAdminMinter(null);
  fv.restore();
});

const OWNER = "owner@test.local";
const login = (email: string) => sessionCookie(makeSession(email));
const J = { "content-type": "application/json" };
function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const post = (path: string, body: unknown, cookie?: string, headers: Record<string, string> = J) =>
  req(path, { method: "POST", cookie, headers, body: JSON.stringify(body) });
const withUser = (email: string, name: string | null) => db.prepare("INSERT OR REPLACE INTO users (email, name, created_at) VALUES (?, ?, ?)").run(email, name, Date.now());

function seed() {
  fv.put({ id: "t1", path: "Tasks/Alpha", tags: ["task", "wiki"], content: "<p>Alpha</p>", metadata: { title: "Alpha", status: "todo", points: 3, prism_creator: "kai@test.local" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "t2", path: "Tasks/Beta", tags: ["task"], content: "", metadata: { title: "Beta", status: "doing", points: 8 }, updatedAt: "2026-10-01T11:00:00.000Z" });
}

// ── H1: the stamp is an opaque subject id, resolved only for signed-in viewers ─

test("H1: the stamp stores an opaque, stable subject id — never an email", async () => {
  seed();
  grantUser("kai@test.local", "tag", "task", "edit");
  assert.equal((await post("/properties/t2", { set: { points: 9 } }, login("kai@test.local"))).status, 200);
  const stamp = fv.notes.get("t2")!.metadata![WRITER_KEY] as string;
  assert.match(stamp, /^u_[0-9a-f]{16}$/);
  assert.equal(stamp, writerIdFor("kai@test.local"), "stable per account");
  assert.notEqual(writerIdFor("kai@test.local"), writerIdFor("mira@test.local"));
  assert.equal(JSON.stringify(fv.notes.get("t2")!.metadata).includes("kai@"), false);
  assert.equal(typeof fv.notes.get("t2")!.metadata![WRITER_AT_KEY], "string", "when it was stamped");
});

test("H1: /query resolves the stamp to a display name for signed-in viewers (sortable, filterable)", async () => {
  seed();
  withUser("kai@test.local", "Kai Moreno");
  grantUser("kai@test.local", "tag", "task", "edit");
  await post("/properties/t2", { set: { points: 9 } }, login("kai@test.local"));
  const body = (await (await post("/query", { tags: ["task"], fields: ["points", WRITER_KEY], filter: { match: "all", conditions: [{ key: WRITER_KEY, op: "contains", value: "kai" }] } }, login(OWNER))).json()) as any;
  assert.deepEqual(body.rows.map((r: any) => [r.id, r.metadata[WRITER_KEY]]), [["t2", "Kai Moreno"]]);
  assert.equal(JSON.stringify(body).includes(WRITER_AT_KEY), false, "the stamp time stays internal");
  const member = (await (await post("/query", { tags: ["task"], fields: [WRITER_KEY] }, login("kai@test.local"))).json()) as any;
  assert.equal(member.rows.find((r: any) => r.id === "t2").metadata[WRITER_KEY], "Kai Moreno");
});

test("L4: a write AFTER the stamp (collab store, ingest, desktop) hides it instead of contradicting 'last edited'", () => {
  const id = writerIdFor("kai@test.local");
  const meta = { [WRITER_KEY]: id, [WRITER_AT_KEY]: "2026-10-02T10:00:00.000Z" };
  const names = new Map([[id, "Kai"]]);
  assert.equal(resolveWriter(meta, "2026-10-02T10:00:00.400Z", names), "Kai", "the stamped write itself");
  assert.equal(resolveWriter(meta, "2026-10-02T10:05:00.000Z", names), null, "someone/something wrote later");
  assert.equal(resolveWriter({ [WRITER_KEY]: "link" }, null, names), "Guest (link)");
  assert.equal(resolveWriter({ [WRITER_KEY]: "u_ffffffffffffffff", [WRITER_AT_KEY]: "2026-10-02T10:00:00.000Z" }, "2026-10-02T10:00:00.000Z", names), null, "unknown account");
});

test("H1: capability links never see, filter or sort by who created/edited a row", async () => {
  seed();
  fv.notes.get("t1")!.metadata![WRITER_KEY] = writerIdFor(OWNER);
  const cap = makeCapability("tag", "task", "view");
  const auth = { ...J, authorization: `Capability ${cap}` };
  const q = (await (await req("/query", { method: "POST", headers: auth, body: JSON.stringify({ tags: ["task"], fields: ["prism_creator", WRITER_KEY, "prism_visibility"] }) })).json()) as any;
  assert.ok(q.rows.length > 0);
  for (const r of q.rows) for (const k of ["prism_creator", WRITER_KEY, "prism_visibility"]) assert.equal(k in r.metadata, false, k);
  const probe = (await (await req("/query", { method: "POST", headers: auth, body: JSON.stringify({ tags: ["task"], filter: { match: "all", conditions: [{ key: "prism_creator", op: "contains", value: "kai" }] } }) })).json()) as any;
  assert.deepEqual(probe.rows, [], "no creator oracle through filters");
  const one = (await (await req("/notes/t1", { headers: auth })).json()) as any;
  assert.equal(one.metadata.prism_creator, undefined);
  assert.equal(one.metadata[WRITER_KEY], undefined);
  const list = (await (await req("/notes", { headers: auth })).json()) as any[];
  for (const n of list) assert.equal(n.metadata?.prism_creator, undefined);
});

test("H1: public pages, GitHub frontmatter and vault mirrors carry no identity stamps", async () => {
  seed();
  fv.notes.get("t1")!.metadata![WRITER_KEY] = writerIdFor(OWNER);
  createPublication({ id: "site", resource_type: "tag", resource: "wiki", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: "test" });
  const page = (await (await publish.request("/site/notes/t1")).json()) as any;
  assert.equal(page.metadata.title, "Alpha");
  for (const k of ["prism_creator", WRITER_KEY, WRITER_AT_KEY]) assert.equal(k in page.metadata, false, k);

  const md = serializeNoteMarkdown({ id: "t1", path: "Tasks/Alpha", tags: ["task"], content: "x", createdAt: "", updatedAt: "", metadata: { title: "A", status: "todo", prism_creator: "kai@test.local", [WRITER_KEY]: "u_1", [WRITER_AT_KEY]: "t" } } as any, "Alpha.md", new Map());
  assert.match(md, /status: todo/);
  assert.equal(/prism_creator|prism_last_writer|prism_last_write_at|kai@/.test(md), false);

  const src = new Map([["s1", { id: "s1", path: "Src/One", tags: [], content: "c", createdAt: "", updatedAt: "2026-10-01T00:00:00Z", metadata: { title: "One", [WRITER_KEY]: "u_1", [WRITER_AT_KEY]: "t" } }]]);
  const dst = new Map<string, any>();
  const vault = (m: Map<string, any>): MirrorVault => ({
    listNotes: async () => [...m.values()],
    getNote: async (id: string) => { const n = m.get(id); if (!n) throw Object.assign(new Error("404"), { status: 404 }); return n; },
    createNote: async (p: any) => { const n = { id: `d${m.size + 1}`, createdAt: "", updatedAt: "", tags: [], ...p }; m.set(n.id, n); return n; },
    updateNote: async (id: string, p: any) => { const n = { ...m.get(id), ...p, metadata: { ...m.get(id).metadata, ...p.metadata } }; m.set(id, n); return n; },
    deleteNote: async (id: string) => { m.delete(id); },
    addTags: async () => {},
    removeTags: async () => {},
  } as unknown as MirrorVault);
  await syncMirror(vault(src), vault(dst), { id: "m1", src_vault: "a", src_prefix: "Src", dest_vault: "b", dest_prefix: "Dst", enabled: true, delete_mode: "archive", created_by: null, created_at: 0, last_run_at: null } as any);
  const copy = [...dst.values()][0];
  assert.ok(copy, "mirrored");
  assert.equal(WRITER_KEY in (copy.metadata ?? {}), false);
});

// ── M4: passthrough stamping is minimal and lossless ─────────────────────────

test("M4: tag-only/path-only owner PATCHes are not stamped; unsafe integers are never re-serialised", async () => {
  seed();
  assert.equal(stampJsonBody(JSON.stringify({ tags: { add: ["x"] } }), { kind: "user", email: OWNER } as any), JSON.stringify({ tags: { add: ["x"] } }));
  assert.equal(stampJsonBody(JSON.stringify({ path: "A/B" }), { kind: "user", email: OWNER } as any), JSON.stringify({ path: "A/B" }));
  const big = '{"metadata":{"ticket":12345678901234567890}}';
  assert.equal(stampJsonBody(big, { kind: "user", email: OWNER } as any), big, "an unsafe integer body passes through byte-for-byte");
  const ok = JSON.parse(stampJsonBody('{"content":"<p>x</p>"}', { kind: "user", email: OWNER } as any));
  assert.equal(ok.metadata[WRITER_KEY], writerIdFor(OWNER));
  // End to end through the gateway: a tag-only PATCH carries no metadata.
  await req("/notes/t2", { method: "PATCH", cookie: login(OWNER), headers: J, body: JSON.stringify({ tags: { add: ["later"] } }) });
  const patch = fv.calls.filter((c) => c.method === "PATCH").at(-1)!;
  assert.equal((patch.body as any).metadata, undefined);
});

test("M4: a non-owner path/tag-only write is not stamped", async () => {
  seed();
  addGrant({ subject_type: "user", subject: "org@test.local", resource_type: "tag", resource: "task", level: "edit", caps: ["view", "edit", "organize"], created_by: "test" });
  // A path change is a move now (wave 2D review C1: PATCH → 403 move_required, nothing written)…
  const moved = await req("/notes/t2", { method: "PATCH", cookie: login("org@test.local"), headers: J, body: JSON.stringify({ path: "Tasks/Beta2" }) });
  assert.equal(moved.status, 403);
  assert.equal(fv.notes.get("t2")!.metadata![WRITER_KEY], undefined);
  // …and a tag-only write is still not stamped.
  const r = await req("/notes/t2", { method: "PATCH", cookie: login("org@test.local"), headers: J, body: JSON.stringify({ add_tags: ["task"] }) });
  assert.equal(r.status, 200);
  assert.equal(fv.notes.get("t2")!.metadata![WRITER_KEY], undefined);
});

// ── H2: no super-linear regex over user values ───────────────────────────────

test("H2: search/eq/contains on huge pathological values stay linear (time-bounded)", () => {
  const evil = ["|".repeat(200_000) + "\nx", "a|".repeat(100_000) + "\nx", "a@" + ".".repeat(100_000) + " ", "[[" + "[".repeat(100_000), " ".repeat(200_000) + "x", "a".repeat(200_000)];
  const rows = evil.map((v, i) => ({ id: `r${i}`, path: null, tags: ["t"], createdAt: "", updatedAt: "", metadata: { title: `row ${i}`, v } }));
  const t0 = threadCpuMs();
  runQuery(rows, { tags: ["t"], search: "zzz" }, { limited: false });
  for (const r of rows) {
    evaluateCondition(r, { key: "v", op: "eq", value: "zzz" });
    evaluateCondition(r, { key: "v", op: "contains", value: "zzz" });
    compareValues(r.metadata.v, "zzz");
    matchesSearch(r, "zzz", ["v"]);
    looksLikeEmail(r.metadata.v);
    linkLabel(r.metadata.v);
    inferKind("v", undefined, r.metadata.v);
  }
  const ms = threadCpuMs() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  // Semantics kept: [[link|alias]] still compares by its target.
  assert.equal(evaluateCondition({ id: "x", path: null, tags: [], createdAt: "", updatedAt: "", metadata: { p: "[[People/Ada|Ada L]]" } }, { key: "p", op: "eq", value: "people/ada" }), true);
  // CSV parser on pathological input.
  const t1 = threadCpuMs();
  parseCsv('"' + '""'.repeat(300_000) + '"', { maxCell: 1_000_000 });
  parseCsv(",".repeat(150), { maxCols: 200 });
  assert.ok(threadCpuMs() - t1 < 1500);
});

// ── M1: keyed re-import on a non-schema property converges ───────────────────

test("M1: import keyed on a non-schema column converges and does not rewrite unchanged cells", async () => {
  seed();
  const csv = "Name,Ext id,Owner note\nAlpha,EXT-1,keep\nGamma,EXT-3,new\n";
  const body = { tag: "task", csv, mapping: { Name: "$title", "Ext id": "ext_id", "Owner note": "owner_note" }, keyColumn: "Ext id", pathPrefix: "Tasks", dryRun: false };
  const first = (await (await post("/databases/import/csv", body, login(OWNER))).json()) as any;
  assert.deepEqual(first.summary, { create: 2, update: 0, unchanged: 0, error: 0 });
  const second = (await (await post("/databases/import/csv", body, login(OWNER))).json()) as any;
  assert.deepEqual(second.summary, { create: 0, update: 0, unchanged: 2, error: 0 }, "re-run converges");
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0, "nothing rewritten");
  // The import listing asks for exactly the keys it reads (lean).
  const listing = fv.calls.filter((c) => c.method === "GET" && /tag=task/.test(c.search)).at(-1)!;
  assert.match(decodeURIComponent(listing.search), /include_metadata=[^&]*ext_id/);
  assert.match(decodeURIComponent(listing.search), /owner_note/);
});

// ── L1/L2/L3 ─────────────────────────────────────────────────────────────────

test("L1: dot and dot-dot titles become Untitled path leaves", async () => {
  assert.equal(safeTitleLeaf(".."), "Untitled");
  assert.equal(safeTitleLeaf("."), "Untitled");
  assert.equal(safeTitleLeaf("a/b"), "a-b");
  seed();
  const r = (await (await post("/databases/import/csv", { tag: "task", csv: "Name\n..\n", mapping: { Name: "$title" }, pathPrefix: "Tasks", dryRun: false }, login(OWNER))).json()) as any;
  assert.equal(r.result.created, 1);
  const made = [...fv.notes.values()].find((n) => n.metadata?.title === "..")!;
  assert.equal(made.path, "Tasks/Untitled");
});

test("L2: single property writes share the per-actor write budget", async () => {
  seed();
  process.env.PROPERTY_BATCH_ITEMS_PER_MINUTE = "2";
  try {
    grantUser("rl@test.local", "tag", "task", "edit");
    const c = login("rl@test.local");
    assert.equal((await post("/properties/t1", { set: { points: 1 } }, c)).status, 200);
    assert.equal((await post("/properties/t2", { set: { points: 1 } }, c)).status, 200);
    assert.equal((await post("/properties/t1", { set: { points: 2 } }, c)).status, 429);
  } finally {
    delete process.env.PROPERTY_BATCH_ITEMS_PER_MINUTE;
  }
});

test("L3: numbers export raw (no formula guard) and round-trip through import coercion", () => {
  const out = toCsv([["Title", "Estimate", "Note"], ["A", { number: -5 }, "=1+1"], ["B", { number: 1200.5 }, "-x"]]);
  assert.equal(out, "Title,Estimate,Note\r\nA,-5,'=1+1\r\nB,1200.5,'-x\r\n");
  const rows = parseCsv(out);
  assert.deepEqual(coerceCsvValue(rows[1]![1]!, { type: "number" }), { value: -5 });
  assert.deepEqual(coerceCsvValue(rows[2]![1]!, { type: "number" }), { value: 1200.5 });
});
