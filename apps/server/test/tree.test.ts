/**
 * WP7.1 tree projection: GET /api/tree.
 * Through the real gateway app with the fake vault and a fake subscribe socket.
 * Invariants: built from ONE lean list; kept fresh by write-through + subscribe
 * frames; ETag 304; non-owners never see rows they cannot view; fallback rebuild
 * when the socket fails; vaults never mix.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { addVaultEntry } from "../src/db";
import { resetTreeForTests, setTreeSocketFactory, type TreeSocket } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  process.env.TREE_SUBSCRIBE = "0";
  process.env.TREE_DEBOUNCE_MS = "10";
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
  process.env.TREE_SUBSCRIBE = "0";
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const ownerReq = (path: string, init?: RequestInit) => req(path, { ...init, cookie: sessionCookie(makeSession(OWNER)) });
const tree = async (r: Response) => (await r.json()) as Array<Record<string, unknown>>;
const listCalls = () => fv.calls.filter((c) => c.method === "GET" && /\/api\/notes$/.test(c.path));

test("built from one lean list; emits only tree fields (no content, no private metadata)", async () => {
  fv.put({ id: "a", path: "docs/a.md", content: "BODY-SECRET", tags: ["doc"], metadata: { prism_type: "document", type: "promise", other: "x", prism_creator: "u@x" } });
  fv.put({ id: "b", path: null, content: "b", tags: null, metadata: null });
  const r = await ownerReq("/tree");
  assert.equal(r.status, 200);
  const body = await tree(r);
  assert.equal(body.length, 2);
  const a = body.find((e) => e.id === "a")!;
  assert.deepEqual(Object.keys(a).sort(), ["id", "path", "prismType", "tags", "type", "updatedAt"]);
  assert.equal(a.prismType, "document");
  assert.equal(a.type, "promise");
  assert.ok(!JSON.stringify(body).includes("BODY-SECRET"));
  assert.ok(!JSON.stringify(body).includes("u@x")); // creator never emitted
  const b = body.find((e) => e.id === "b")!;
  assert.deepEqual(b.tags, []);
  assert.equal(b.path, null);
  // One lean list, asking only for the keys it needs.
  const calls = listCalls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.search.includes("include_metadata="));
  assert.ok(!calls[0]!.search.includes("include_content=true"));
  // A second read is served from memory.
  await ownerReq("/tree");
  assert.equal(listCalls().length, 1);
});

test("page icon (NP-PG-01): a short emoji is emitted and follows a metadata write; anything long is dropped", async () => {
  fv.put({ id: "a", path: "a.md", content: "", tags: [], metadata: { icon: "🌱" } });
  fv.put({ id: "b", path: "b.md", content: "", tags: [], metadata: { icon: "x".repeat(33) } });
  fv.put({ id: "c", path: "c.md", content: "", tags: [], metadata: { icon: 7 } });
  let body = await tree(await ownerReq("/tree"));
  assert.equal(body.find((e) => e.id === "a")?.icon, "🌱");
  assert.ok(!("icon" in body.find((e) => e.id === "b")!));
  assert.ok(!("icon" in body.find((e) => e.id === "c")!));
  assert.ok(listCalls()[0]!.search.includes("icon"));
  const r = await ownerReq("/notes/c", { method: "PATCH", body: JSON.stringify({ metadata: { icon: "📌" }, force: true }) });
  assert.equal(r.status, 200);
  await tick();
  body = await tree(await ownerReq("/tree"));
  assert.equal(body.find((e) => e.id === "c")?.icon, "📌");
});

test("title + aliases (wikilink/mention matching): emitted only when present and within bounds, follow a write, change the ETag, never for an unviewable note", async () => {
  fv.put({ id: "a", path: "docs/q3-plan.md", content: "", tags: ["doc"], metadata: { title: "Quarterly Roadmap", aliases: ["Q3", "  ", 7, "x".repeat(101), "roadmap"] } });
  fv.put({ id: "b", path: "b.md", content: "", tags: [], metadata: { title: "t".repeat(201), aliases: "not-a-list" } });
  fv.put({ id: "c", path: "c.md", content: "", tags: [], metadata: { title: "", aliases: Array.from({ length: 14 }, (_, i) => `alias ${i}`) } });
  fv.put({ id: "d", path: "d.md", content: "", tags: ["secret"], metadata: { title: "Hidden Title", aliases: ["hidden-alias"] } });
  const r1 = await ownerReq("/tree");
  let body = await tree(r1);
  const a = body.find((e) => e.id === "a")!;
  assert.equal(a.title, "Quarterly Roadmap");
  assert.deepEqual(a.aliases, ["Q3", "roadmap"]); // blank, non-string and over-long entries dropped
  const b = body.find((e) => e.id === "b")!;
  assert.ok(!("title" in b) && !("aliases" in b));
  const c = body.find((e) => e.id === "c")!;
  assert.ok(!("title" in c));
  assert.equal((c.aliases as string[]).length, 10);
  const search = decodeURIComponent(listCalls()[0]!.search);
  assert.ok(/[=,]title(,|&|$)/.test(search) && /[=,]aliases(,|&|$)/.test(search), search);

  // A title / alias write goes through to the projection and changes the ETag.
  const etag = r1.headers.get("etag")!;
  const w = await ownerReq("/notes/b", { method: "PATCH", body: JSON.stringify({ metadata: { title: "Budget", aliases: ["money"] }, force: true }) });
  assert.equal(w.status, 200);
  await tick();
  const r2 = await ownerReq("/tree", { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 200);
  assert.notEqual(r2.headers.get("etag"), etag);
  body = await tree(r2);
  assert.equal(body.find((e) => e.id === "b")?.title, "Budget");
  assert.deepEqual(body.find((e) => e.id === "b")?.aliases, ["money"]);

  // A member who can view only `doc` notes gets a's title and nothing of d.
  grantUser("m@test.local", "tag", "doc", "view");
  const rm = await req("/tree", { cookie: sessionCookie(makeSession("m@test.local")) });
  const text = await rm.text();
  assert.ok(text.includes("Quarterly Roadmap"));
  assert.ok(!text.includes("Hidden Title") && !text.includes("hidden-alias"));
});

test("title + aliases hardening: control/bidi characters stripped, singular alias, no title equal to the file name, and never another member's private title", async () => {
  fv.put({ id: "a", path: "docs/plan.md", content: "", tags: ["doc"], metadata: { title: "Road\u202emap\u0007 \u2066Q3\u2069\nplan", aliases: ["al\u200fias\u0000", "\u202e"], alias: "Solo" } });
  fv.put({ id: "b", path: "docs/Budget.md", content: "", tags: [], metadata: { title: "Budget", alias: "money" } });
  fv.put({ id: "c", path: "docs/Notes", content: "", tags: [], metadata: { title: "Notes" } });
  fv.put({ id: "p", path: "private/diary.md", content: "", tags: ["doc"], metadata: { title: "Secret Diary Title", aliases: ["secret-alias"], prism_visibility: "private", prism_creator: "m@test.local" } });
  fv.put({ id: "o", path: "private/mine.md", content: "", tags: [], metadata: { title: "Owner Private", prism_visibility: "private", prism_creator: OWNER } });
  const r = await ownerReq("/tree");
  const text = await r.text();
  const body = JSON.parse(text) as Array<Record<string, unknown>>;
  const a = body.find((e) => e.id === "a")!;
  assert.equal(a.title, "Roadmap Q3 plan");
  assert.deepEqual(a.aliases, ["alias", "Solo"]);
  // A title that only repeats the file name adds nothing: not emitted. The alias still is.
  const b = body.find((e) => e.id === "b")!;
  assert.ok(!("title" in b));
  assert.deepEqual(b.aliases, ["money"]);
  assert.ok(!("title" in body.find((e) => e.id === "c")!));
  // The admin tree lists another member's private note (path, as before) but not its title/aliases.
  const p = body.find((e) => e.id === "p")!;
  assert.equal(p.path, "private/diary.md");
  assert.ok(!("title" in p) && !("aliases" in p));
  assert.ok(!text.includes("Secret Diary Title") && !text.includes("secret-alias"));
  assert.equal(body.find((e) => e.id === "o")?.title, "Owner Private");
  // Its creator (a member who can view it) does get them.
  grantUser("m@test.local", "tag", "doc", "view");
  const mine = await tree(await req("/tree", { cookie: sessionCookie(makeSession("m@test.local")) }));
  assert.equal(mine.find((e) => e.id === "p")?.title, "Secret Diary Title");
  assert.deepEqual(mine.find((e) => e.id === "p")?.aliases, ["secret-alias"]);
  // The owner's cached body is not handed to another admin-level reader as-is, and repeats are stable.
  const again = await ownerReq("/tree");
  assert.equal(again.headers.get("etag"), r.headers.get("etag"));
});

test("ETag: If-None-Match gives 304; a change gives a new tag and 200", async () => {
  fv.put({ id: "a", path: "a.md", content: "", tags: [] });
  const r1 = await ownerReq("/tree");
  const etag = r1.headers.get("etag")!;
  assert.ok(etag);
  const r2 = await ownerReq("/tree", { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);
  assert.equal(await r2.text(), "");
  const c = await ownerReq("/notes", { method: "POST", body: JSON.stringify({ content: "n", path: "n.md", tags: [] }) });
  assert.equal(c.status, 200);
  await tick();
  const r3 = await ownerReq("/tree", { headers: { "If-None-Match": etag } });
  assert.equal(r3.status, 200);
  assert.notEqual(r3.headers.get("etag"), etag);
});

test("owner write-through: create / update / tag change / delete show up without another vault list", async () => {
  fv.put({ id: "a", path: "a.md", content: "", tags: ["x"] });
  await ownerReq("/tree");
  const created = (await (await ownerReq("/notes", { method: "POST", body: JSON.stringify({ content: "n", path: "new/n.md", tags: ["t"] }) })).json()) as { id: string };
  await tick();
  let body = await tree(await ownerReq("/tree"));
  assert.equal(body.find((e) => e.id === created.id)?.path, "new/n"); // the vault strips a trailing .md (the fake now does too)

  await ownerReq(`/notes/${created.id}`, { method: "PATCH", body: JSON.stringify({ path: "moved/n.md" }) });
  await tick();
  body = await tree(await ownerReq("/tree"));
  assert.equal(body.find((e) => e.id === created.id)?.path, "moved/n");

  await ownerReq("/notes/a", { method: "PATCH", body: JSON.stringify({ tags: { add: ["y"], remove: ["x"] } }) });
  await tick();
  body = await tree(await ownerReq("/tree"));
  assert.deepEqual(body.find((e) => e.id === "a")?.tags, ["y"]);

  await ownerReq("/notes/a", { method: "DELETE" });
  await tick();
  body = await tree(await ownerReq("/tree"));
  assert.ok(!body.some((e) => e.id === "a"));
  assert.equal(listCalls().length, 1, "never re-listed the vault");
});

test("non-owner write-through (create / edit / delete through the gateway) updates the projection", async () => {
  grantUser("m@x.test", "tag", "proj", "edit");
  fv.put({ id: "p1", path: "proj/one.md", content: "1", tags: ["proj"] });
  const cookie = sessionCookie(makeSession("m@x.test"));
  await req("/tree", { cookie }); // build
  const created = (await (await req("/notes", { method: "POST", cookie, body: JSON.stringify({ content: "c", path: "proj/two.md", tags: ["proj"] }) })).json()) as { id: string };
  let body = await tree(await req("/tree", { cookie }));
  assert.ok(body.some((e) => e.id === created.id));
  await req("/notes/p1", { method: "PATCH", cookie, body: JSON.stringify({ content: "edited", metadata: { prism_type: "code" } }) });
  body = await tree(await req("/tree", { cookie }));
  assert.equal(body.find((e) => e.id === "p1")?.prismType, "code");
  await req(`/notes/${created.id}`, { method: "DELETE", cookie });
  body = await tree(await req("/tree", { cookie }));
  assert.ok(!body.some((e) => e.id === created.id));
});

test("non-owner sees only rows they can view; anon sees nothing; no path/tag leak", async () => {
  fv.put({ id: "pub", path: "proj/pub.md", content: "", tags: ["proj"] });
  fv.put({ id: "hidden", path: "secret/plans.md", content: "", tags: ["secret", "exec"] });
  fv.put({ id: "mine", path: "secret/mine.md", content: "", tags: ["secret"] });
  fv.put({ id: "priv", path: "proj/private.md", content: "", tags: ["proj"], metadata: { prism_visibility: "private", prism_creator: "someone@else" } });
  grantUser("v@x.test", "tag", "proj", "view");
  grantUser("v@x.test", "note", "mine", "view");
  await ownerReq("/tree"); // warm the shared projection as the owner first
  const raw = await (await req("/tree", { cookie: sessionCookie(makeSession("v@x.test")) })).text();
  const ids = (JSON.parse(raw) as Array<{ id: string }>).map((e) => e.id).sort();
  assert.deepEqual(ids, ["mine", "pub"]);
  assert.ok(!raw.includes("secret/plans") && !raw.includes("exec") && !raw.includes("priv"));
  assert.deepEqual(await tree(await req("/tree")), []);
  // A signed-in user with no grants sees nothing.
  assert.deepEqual(await tree(await req("/tree", { cookie: sessionCookie(makeSession("nobody@x.test")) })), []);
});

test("multi-vault: each vault has its own projection, selected by X-Prism-Vault", async () => {
  addVaultEntry({ id: "team-b", label: "B", url: "http://vault.test", vault: "team-b", token: "tb" });
  fv.addVault("team-b");
  fv.put({ id: "a1", path: "a/1.md", content: "", tags: [] });
  fv.putIn("team-b", { id: "b1", path: "b/1.md", content: "", tags: [] });
  const a = await tree(await ownerReq("/tree"));
  const b = await tree(await ownerReq("/tree", { headers: { "X-Prism-Vault": "team-b" } }));
  assert.deepEqual(a.map((e) => e.id), ["a1"]);
  assert.deepEqual(b.map((e) => e.id), ["b1"]);
  // A write in B does not leak into A's projection.
  await ownerReq("/notes", { method: "POST", headers: { "X-Prism-Vault": "team-b" }, body: JSON.stringify({ content: "n", path: "b/2.md", tags: [] }) });
  await tick();
  assert.equal((await tree(await ownerReq("/tree"))).length, 1);
  assert.equal((await tree(await ownerReq("/tree", { headers: { "X-Prism-Vault": "team-b" } }))).length, 2);
});

// ---------------------------------------------------------------- subscribe

class FakeSocket implements TreeSocket {
  onopen: TreeSocket["onopen"] = null;
  onmessage: TreeSocket["onmessage"] = null;
  onclose: TreeSocket["onclose"] = null;
  onerror: TreeSocket["onerror"] = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  frame(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}
function useSockets(): FakeSocket[] {
  const socks: FakeSocket[] = [];
  setTreeSocketFactory((url) => {
    const s = new FakeSocket(url);
    socks.push(s);
    return s;
  });
  process.env.TREE_SUBSCRIBE = "1";
  return socks;
}
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick(5);
  assert.ok(cond(), "condition not reached");
}

test("subscribe: snapshot builds the tree WITHOUT a REST list; upsert/remove frames apply", async () => {
  const socks = useSockets();
  fv.put({ id: "ignored", path: "x.md", content: "", tags: [] }); // the REST list must not be used
  const p = ownerReq("/tree");
  await waitFor(() => socks.length === 1);
  const s = socks[0]!;
  assert.ok(s.url.startsWith("ws://vault.test/vault/default/api/subscribe"));
  assert.ok(s.url.includes("include_content=false"));
  s.onopen?.();
  assert.deepEqual(JSON.parse(s.sent[0]!), { type: "auth", token: "test-vault-token" });
  // A chunked snapshot: two frames, only the last done.
  s.frame({ type: "snapshot", notes: [{ id: "s1", path: "s/1.md", tags: ["t"], updatedAt: "2026-06-01T00:00:00Z", metadata: { prism_type: "document" } }], done: false });
  s.frame({ type: "snapshot", notes: [{ id: "s2", path: "s/2.md", tags: [], updatedAt: "2026-06-01T00:00:00Z", metadata: {} }], done: true });
  const first = await tree(await p);
  assert.deepEqual(first.map((e) => e.id).sort(), ["s1", "s2"]);
  assert.equal(listCalls().length, 0);

  // A vault-side edit made elsewhere arrives as an upsert.
  s.frame({ type: "upsert", note: { id: "s3", path: "s/3.md", tags: ["new"], updatedAt: "2026-06-02T00:00:00Z", metadata: { type: "task" } } });
  s.frame({ type: "upsert", note: { id: "s1", path: "moved/1.md", tags: ["t"], updatedAt: "2026-06-02T00:00:00Z", metadata: {} } });
  s.frame({ type: "remove", id: "s2" });
  const after = await tree(await ownerReq("/tree"));
  assert.deepEqual(after.map((e) => e.id).sort(), ["s1", "s3"]);
  assert.equal(after.find((e) => e.id === "s1")?.path, "moved/1.md");
  assert.equal(after.find((e) => e.id === "s3")?.type, "task");
  // Stale upsert (older updatedAt) is ignored.
  s.frame({ type: "upsert", note: { id: "s1", path: "OLD.md", tags: [], updatedAt: "2026-01-01T00:00:00Z", metadata: {} } });
  assert.equal((await tree(await ownerReq("/tree"))).find((e) => e.id === "s1")?.path, "moved/1.md");
  assert.equal(socks.length, 1);
});

test("subscribe: a reconnect snapshot replaces the rows wholesale (self-correcting)", async () => {
  const socks = useSockets();
  const p = ownerReq("/tree");
  await waitFor(() => socks.length === 1);
  socks[0]!.onopen?.();
  socks[0]!.frame({ type: "snapshot", notes: [{ id: "old", path: "o.md", tags: [], updatedAt: "2026-06-01T00:00:00Z" }], done: true });
  await p;
  socks[0]!.close(); // vault restart; the projection keeps serving the last rows
  assert.deepEqual((await tree(await ownerReq("/tree"))).map((e) => e.id), ["old"]);
});

test("fallback: socket fails before a snapshot, so the tree is built from a lean list", async () => {
  const socks = useSockets();
  fv.put({ id: "f1", path: "f/1.md", content: "", tags: [] });
  const p = ownerReq("/tree");
  await waitFor(() => socks.length === 1);
  socks[0]!.close(); // connection refused / closed before any snapshot
  const body = await tree(await p);
  assert.deepEqual(body.map((e) => e.id), ["f1"]);
  assert.equal(listCalls().length, 1);
});

test("fallback: a socket that never sends a snapshot times out into a lean list", async () => {
  const socks = useSockets();
  process.env.TREE_SNAPSHOT_TIMEOUT_MS = "40";
  try {
    fv.put({ id: "t1", path: "t/1.md", content: "", tags: [] });
    const p = ownerReq("/tree");
    await waitFor(() => socks.length === 1);
    socks[0]!.onopen?.(); // authed, but the vault is too busy to snapshot
    assert.deepEqual((await tree(await p)).map((e) => e.id), ["t1"]);
    assert.ok(socks[0]!.closed);
  } finally {
    delete process.env.TREE_SNAPSHOT_TIMEOUT_MS;
  }
});

test("a tag rename/merge (broad change) triggers a debounced lean rebuild", async () => {
  fv.put({ id: "a", path: "a.md", content: "", tags: ["old"] });
  await ownerReq("/tree");
  assert.equal(listCalls().length, 1);
  fv.notes.get("a")!.tags = ["renamed"]; // what the vault did
  await ownerReq("/tags/old/rename", { method: "POST", body: "{}" });
  await tick(120);
  assert.equal(listCalls().length, 2);
  assert.deepEqual((await tree(await ownerReq("/tree")))[0]!.tags, ["renamed"]);
});

test("vault unreachable on first build gives 502, and the next request retries", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  const r = await ownerReq("/tree");
  globalThis.fetch = real;
  assert.equal(r.status, 502);
  fv.put({ id: "a", path: "a.md", content: "", tags: [] });
  assert.equal((await tree(await ownerReq("/tree"))).length, 1);
});
