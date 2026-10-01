/**
 * RAG: unit coverage for chunking / embedding / fusion / store, plus end-to-end
 * coverage of the /api/search/semantic + /api/index/* routes through the REAL
 * app pipeline (actor resolution + authorization), with a fake vault and the
 * deterministic offline HashEmbedder (no model/network needed).
 */
import Database from "better-sqlite3";
import { initializeScopedIndex, CHUNKER_ID } from "../src/rag/migration";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db } from "../src/db";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  grantUser,
  type FakeVault,
} from "./helpers";

import { chunkText, chunkNote, toPlainText } from "../src/rag/chunk";
import { HashEmbedder, cosine, normalize } from "../src/rag/embedder";
import { reciprocalRankFusion } from "../src/rag/fusion";
import { upsertNoteChunks, queryTopK, indexedHash, removeNoteChunks } from "../src/rag/store";
import { runIndexOnce, indexSweepEnabled } from "../src/worker/scheduler";
import { getEmbedder } from "../src/rag/embedder";
import { getWorkerCursor, addGrant, addVaultEntry } from "../src/db";
import { signCapability } from "../src/auth/capability";
import { config } from "../src/config";
import { indexJobs } from "../src/rag/runtime";

const OWNER = "owner@test.local"; // matches .env.test OWNER_EMAIL

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  db.exec("DELETE FROM embeddings; DELETE FROM embeddings_v2; DELETE FROM search_index_job_items; DELETE FROM search_index_jobs");
  fv = installFakeVault();
});
afterEach(() => fv.restore());

// ---- chunking ----

test("toPlainText strips tags and preserves paragraph breaks", () => {
  const t = toPlainText("<h1>Title</h1><p>Hello <b>world</b></p><p>Second</p>");
  assert.match(t, /Title/);
  assert.match(t, /Hello world/);
  assert.match(t, /Second/);
  assert.ok(!t.includes("<"));
});

test("chunkText returns one chunk for short text, many for long", () => {
  assert.equal(chunkText("short note").length, 1);
  const long = "sentence about systems. ".repeat(300); // ~7200 chars
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1, "long text splits into multiple chunks");
  assert.ok(chunks.every((c) => c.text.length <= 1400), "chunks stay near the target size");
  assert.deepEqual(
    chunks.map((c) => c.index),
    chunks.map((_, i) => i),
    "indices are sequential",
  );
});

test("chunkNote on empty content yields no chunks", () => {
  assert.equal(chunkNote("   ").length, 0);
  assert.equal(chunkNote("<p></p>").length, 0);
});

// ---- embedder ----

test("HashEmbedder is deterministic and normalized", async () => {
  const e = new HashEmbedder(128);
  const [a1] = await e.embed(["food systems and local agriculture"]);
  const [a2] = await e.embed(["food systems and local agriculture"]);
  assert.deepEqual([...a1!], [...a2!], "same text → identical vector");
  assert.ok(Math.abs(cosine(a1!, a1!) - 1) < 1e-6, "self-cosine ≈ 1 (normalized)");
});

test("HashEmbedder: lexical overlap raises cosine similarity", async () => {
  const e = new HashEmbedder(512);
  const [q, near, far] = await e.embed([
    "regenerative food systems",
    "food systems for regenerative agriculture",
    "quarterly budget spreadsheet for marketing",
  ]);
  assert.ok(cosine(q!, near!) > cosine(q!, far!), "shared vocabulary ranks higher");
});

test("normalize handles the zero vector without NaN", () => {
  const z = normalize(new Float32Array([0, 0, 0]));
  assert.deepEqual([...z], [0, 0, 0]);
});

// ---- fusion ----

test("reciprocalRankFusion rewards agreement across signals", () => {
  const fused = reciprocalRankFusion({
    dense: ["a", "b", "c"],
    sparse: ["b", "a", "d"],
  });
  // "a" (ranks 0,1) and "b" (ranks 1,0) both appear in both → top two.
  assert.deepEqual(
    fused.slice(0, 2).map((f) => f.id).sort(),
    ["a", "b"],
  );
  // a dense-only "c" and sparse-only "d" rank below the agreed pair.
  assert.ok(fused.find((f) => f.id === "c")!.score < fused[0]!.score);
});

// ---- store ----

test("store upsert + queryTopK returns nearest chunk first", async () => {
  const e = new HashEmbedder(256);
  const docs = [
    { id: "n1", text: "permaculture and soil regeneration" },
    { id: "n2", text: "javascript build tooling and bundlers" },
  ];
  for (const d of docs) {
    const [v] = await e.embed([d.text]);
    upsertNoteChunks(d.id, "h-" + d.id, e.id, [{ idx: 0, text: d.text, vec: v! }]);
  }
  const [q] = await e.embed(["soil and permaculture"]);
  const top = queryTopK(e.id, q!, 5);
  assert.equal(top[0]!.noteId, "n1", "soil/permaculture query retrieves n1");
});

test("indexedHash tracks the stored content hash (incremental skip)", async () => {
  const e = new HashEmbedder(64);
  const [v] = await e.embed(["hello"]);
  upsertNoteChunks("n1", "hash-A", e.id, [{ idx: 0, text: "hello", vec: v! }]);
  assert.equal(indexedHash("n1", e.id), "hash-A");
  removeNoteChunks("n1");
  assert.equal(indexedHash("n1", e.id), null);
});

// ---- routes: indexing + hybrid search through the real pipeline ----

async function seedAndIndex(app: ReturnType<typeof createApp>, cookie: string) {
  fv.put({ id: "doc-food", content: "Regenerative food systems and local agriculture in community resilience.", tags: ["shared"] });
  fv.put({ id: "doc-code", content: "TypeScript bundler configuration and Vite build performance tuning.", tags: ["private"] });
  fv.put({ id: "doc-grant", content: "Grant application for regenerative agriculture funding and food sovereignty.", tags: ["shared"] });
  const res = await app.request("/api/index/rebuild", { method: "POST", headers: { cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

test("owner can rebuild the index and see status", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(OWNER));
  const summary = (await seedAndIndex(app, cookie)) as { total: number; indexed: number };
  assert.equal(summary.total, 3);
  assert.equal(summary.indexed, 3);

  const status = (await (await app.request("/api/index/status", { headers: { cookie } })).json()) as {
    notes: number;
    chunks: number;
  };
  assert.equal(status.notes, 3);
  assert.ok(status.chunks >= 3);
});

test("owner semantic search returns hybrid-ranked notes with snippets", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(OWNER));
  await seedAndIndex(app, cookie);

  const res = await app.request("/api/search/semantic?q=regenerative+agriculture+food", { headers: { cookie } });
  assert.equal(res.status, 200);
  const hits = (await res.json()) as Array<{ id: string; _score: number; _snippet: string }>;
  assert.ok(hits.length >= 2, "finds the food + grant notes");
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes("doc-food") && ids.includes("doc-grant"));
  assert.ok(hits[0]!._score > 0 && typeof hits[0]!._snippet === "string");
});

test("non-owner semantic results are filtered to granted notes", async () => {
  const app = createApp();
  const ownerCookie = sessionCookie(makeSession(OWNER));
  await seedAndIndex(app, ownerCookie);

  // A collaborator who can view only the "shared" tag.
  const collab = "collab@test.local";
  grantUser(collab, "tag", "shared", "view");
  const collabCookie = sessionCookie(makeSession(collab));

  const res = await app.request("/api/search/semantic?q=regenerative+food+typescript", { headers: { cookie: collabCookie } });
  assert.equal(res.status, 200);
  const ids = ((await res.json()) as Array<{ id: string }>).map((h) => h.id);
  assert.ok(!ids.includes("doc-code"), "private note never leaks to a non-owner");
  assert.ok(ids.every((id) => id !== "doc-code"));
});

test("index mutation routes are owner-only", async () => {
  const app = createApp();
  const anon = await app.request("/api/index/rebuild", { method: "POST" });
  assert.equal(anon.status, 403);
  const status = await app.request("/api/index/status");
  assert.equal(status.status, 403);

  const collab = "collab@test.local";
  const collabCookie = sessionCookie(makeSession(collab));
  const post = await app.request("/api/index/notes", {
    method: "POST",
    headers: { cookie: collabCookie, "content-type": "application/json" },
    body: JSON.stringify({ notes: [{ id: "x", content: "y" }] }),
  });
  assert.equal(post.status, 403);
});

test("anon semantic search returns nothing (no grants)", async () => {
  const app = createApp();
  const ownerCookie = sessionCookie(makeSession(OWNER));
  await seedAndIndex(app, ownerCookie);
  const res = await app.request("/api/search/semantic?q=food");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

// ---- WP0.2: read gate is the `view` CAP; the index is primary-vault only ----

test("a create-only caps grant gets NO semantic hits (the ladder floor does not leak)", async () => {
  const app = createApp();
  await seedAndIndex(app, sessionCookie(makeSession(OWNER)));

  // ["create"] projects to level "view" (levelForCaps) but confers no read.
  const dropbox = "dropbox@test.local";
  const g = addGrant({ subject_type: "user", subject: dropbox, resource_type: "tag", resource: "shared", level: "view", caps: ["create"], created_by: "test" });
  assert.equal(g.level, "view", "precondition: ladder projection floors at view");
  const res = await app.request("/api/search/semantic?q=regenerative+food", { headers: { cookie: sessionCookie(makeSession(dropbox)) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [], "no hit for a note the actor cannot read");
  // Same actor, same note, via the gateway: also refused (consistency).
  const direct = await app.request("/api/notes/doc-food", { headers: { cookie: sessionCookie(makeSession(dropbox)) } });
  assert.equal(direct.status, 403);

  // Control: adding `view` to the caps makes the same notes appear.
  const viewer = "viewer@test.local";
  addGrant({ subject_type: "user", subject: viewer, resource_type: "tag", resource: "shared", level: "view", caps: ["view", "create"], created_by: "test" });
  const ok = await app.request("/api/search/semantic?q=regenerative+food", { headers: { cookie: sessionCookie(makeSession(viewer)) } });
  const ids = ((await ok.json()) as Array<{ id: string }>).map((h) => h.id);
  assert.ok(ids.includes("doc-food") && !ids.includes("doc-code"));
});

test("semantic search and capabilities hydrate only their own vault even with identical IDs and tags", async () => {
  const app = createApp();
  const ownerCookie = sessionCookie(makeSession(OWNER));
  await seedAndIndex(app, ownerCookie);
  addVaultEntry({ id: "frb", label: "Other", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.putIn("frb", { id: "doc-food", content: "Secondary forest food plan", tags: ["shared"] });
  const index = await app.request("/api/index/rebuild", { method: "POST", headers: { cookie: ownerCookie, "x-prism-vault": "frb" } });
  assert.equal(index.status, 200);
  const member = "member-b@test.local";
  addGrant({ subject_type: "user", subject: member, resource_type: "tag", resource: "shared", level: "view", vault_id: "frb", created_by: "test" });
  const result = await app.request("/api/search/semantic?q=food", { headers: { cookie: sessionCookie(makeSession(member)), "x-prism-vault": "frb" } });
  assert.equal(result.status, 200);
  const hits = await result.json() as Array<{ id: string; content: string; _snippet: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.content, "Secondary forest food plan");
  assert.equal(hits[0]?._snippet, "Secondary forest food plan");
  const capId = "cap-frb-shared";
  addGrant({ subject_type: "link", subject: capId, resource_type: "tag", resource: "shared", level: "view", vault_id: "frb", created_by: "test" });
  const token = signCapability({ id: capId, exp: Date.now() + 60_000 });
  const linked = await app.request(`/api/search/semantic?q=food&t=${encodeURIComponent(token)}`);
  assert.deepEqual(await linked.json(), hits);
  const primary = await app.request("/api/search/semantic?q=food", { headers: { cookie: ownerCookie } });
  assert.ok(!(await primary.text()).includes("Secondary forest"));
  db.prepare("DELETE FROM prism_vaults WHERE id = ?").run("frb");
  const retired = await app.request(`/api/search/semantic?q=food&t=${encodeURIComponent(token)}`);
  assert.equal(retired.status, 409, "a retired link vault cannot fall back to primary");
});

test("index writes, status and deletion affect only the selected vault", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(OWNER));
  await seedAndIndex(app, cookie);
  addVaultEntry({ id: "frb", label: "Other", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.addVault("frb");
  const headers = { cookie, "x-prism-vault": "frb", "content-type": "application/json" };
  const indexed = await app.request("/api/index/notes", { method: "POST", headers, body: JSON.stringify({ notes: [{ id: "doc-food", content: "secondary" }] }) });
  assert.equal(indexed.status, 200);
  const status = await (await app.request("/api/index/status", { headers })).json() as { vaultId: string; notes: number };
  assert.equal(status.vaultId, "frb");
  assert.equal(status.notes, 1);
  assert.equal((await app.request("/api/index/notes/doc-food", { method: "DELETE", headers })).status, 200);
  assert.equal((await (await app.request("/api/index/status", { headers })).json() as { notes: number }).notes, 0);
  assert.equal((await (await app.request("/api/index/status", { headers: { cookie } })).json() as { notes: number }).notes, 3);
});

// ---- worker index maintenance (audit 2026-08-13, F2) ----
test("durable index jobs require admin access and remain bound to the credential vault", async () => {
  const app = createApp();
  fv.put({id:"same",content:"primary body"});
  addVaultEntry({ id: "frb", label: "Other", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.putIn("frb",{id:"same",content:"secondary body"});
  const member = sessionCookie(makeSession("member@test.local"));
  assert.equal((await app.request("/api/index/jobs",{method:"POST",headers:{cookie:member}})).status,403);
  const headers={cookie:sessionCookie(makeSession(OWNER)),"x-prism-vault":"frb"};
  assert.equal((await app.request("/api/index/jobs",{method:"POST",headers:{...headers,"x-prism-write-actor":"user:other@test.local"}})).status,409);
  const started=await app.request("/api/index/jobs",{method:"POST",headers});
  assert.equal(started.status,202);
  const job=await started.json() as {id:string};
  const wrongVault={cookie:headers.cookie};
  assert.equal((await app.request(`/api/index/jobs/${job.id}/pause`,{method:"POST",headers:wrongVault})).status,404);
  await indexJobs.runSlice();
  const status=await (await app.request("/api/index/status",{headers})).json() as {vaultId:string;job:{state:string};notes:number};
  assert.equal(status.vaultId,"frb");
  assert.equal(status.job.state,"completed");
  assert.equal(status.notes,1);
  assert.equal(indexedHash("same",getEmbedder().id),null,"primary index untouched");
  assert.ok(fv.calls.filter(c=>c.path.endsWith('/notes')).every(c=>!c.search.includes('include_content=true')),"no bulk bodies");
});
//
// Before this existed, the ONLY caller of indexNote was the desktop app pushing
// to /api/index/notes — so the index advanced only while the desktop was open,
// and web/mobile silently searched a stale index. These cover the server-owned
// sweep that replaced that dependency.

test("the worker sweep indexes the whole vault on its first run (no cursor)", async () => {
  fv.put({ id: "n1", content: "sourdough starter hydration", path: "a", metadata: null, tags: [] });
  fv.put({ id: "n2", content: "kubernetes ingress controller", path: "b", metadata: null, tags: [] });

  const indexed = await runIndexOnce();
  assert.equal(indexed, 2, "both notes embedded on the backfill pass");

  const model = getEmbedder().id;
  assert.ok(indexedHash("n1", model), "n1 has vectors");
  assert.ok(indexedHash("n2", model), "n2 has vectors");
  assert.ok(getWorkerCursor("primary", `index-sweep:${model}`), "cursor advanced");
});

test("a second sweep with nothing changed re-embeds nothing", async () => {
  fv.put({ id: "n1", content: "sourdough starter hydration", path: "a", metadata: null, tags: [] });
  await runIndexOnce();
  assert.equal(await runIndexOnce(), 0, "steady state is free");
});

test("the sweep picks up a note changed since the cursor", async () => {
  fv.put({ id: "n1", content: "original body", path: "a", metadata: null, tags: [], updatedAt: "2026-01-01T00:00:00Z" });
  await runIndexOnce();
  const model = getEmbedder().id;
  const before = indexedHash("n1", model);

  fv.put({ id: "n1", content: "a completely different body", path: "a", metadata: null, tags: [], updatedAt: "2026-02-01T00:00:00Z" });
  assert.equal(await runIndexOnce(), 1, "the changed note was re-embedded");
  assert.notEqual(indexedHash("n1", model), before, "its content hash moved");
});

test("the sweep de-indexes a note that vanished from the vault", async () => {
  fv.put({ id: "n1", content: "still here", path: "a", metadata: null, tags: [] });
  fv.put({ id: "gone", content: "delete me", path: "b", metadata: null, tags: [] });
  await runIndexOnce();
  const model = getEmbedder().id;
  assert.ok(indexedHash("gone", model), "indexed to begin with");

  fv.notes.delete("gone");
  await runIndexOnce();
  assert.equal(indexedHash("gone", model), null, "orphan vectors dropped");
  assert.ok(indexedHash("n1", model), "the surviving note is untouched");
});

test("INDEX_INTERVAL_MS=0 disables the sweep (this test env sets it)", () => {
  // The off-switch is what keeps an unref'd background timer out of the suite;
  // if it ever defaults back on, cross-test vault traffic returns.
  assert.equal(config.indexIntervalMs, 0);
  assert.equal(indexSweepEnabled(), false);
});

test("concurrent sweeps cannot overlap (in-flight guard)", async () => {
  // A first-run backfill outlasts the sweep interval, so the timer would
  // otherwise start a second pass over the same notes mid-flight.
  fv.put({ id: "n1", content: "one", path: "a", metadata: null, tags: [] });
  fv.put({ id: "n2", content: "two", path: "b", metadata: null, tags: [] });
  const [a, b] = await Promise.all([runIndexOnce(), runIndexOnce()]);
  assert.equal(a + b, 2, "the two notes were embedded exactly once between them");
  assert.ok(a === 0 || b === 0, "one call short-circuited instead of racing");
});

test("a note missing from the index is retried on the next sweep (self-healing)", async () => {
  fv.put({ id: "ok1", content: "fine", path: "a", metadata: null, tags: [] });
  const model = getEmbedder().id;

  // A note that was unreachable during a sweep ends it with no vectors. Simulate
  // that end state by indexing while it is absent, then restoring it.
  const missed = { id: "missed", content: "body", path: "b", metadata: null, tags: [], updatedAt: "2026-03-01T00:00:00Z" };
  await runIndexOnce();
  assert.ok(indexedHash("ok1", model), "the reachable note indexed");
  assert.equal(indexedHash("missed", model), null, "the absent note has no vectors");

  // Restore it. The cursor has already advanced past its updatedAt, so a
  // timestamp-only sweep would skip it forever. Selection is by what the index
  // is MISSING, so the next pass must pick it up.
  fv.put(missed);
  assert.equal(await runIndexOnce(), 1, "re-selected on the next pass");
  assert.ok(indexedHash("missed", model), "and now has vectors");
});

test("the sweep converges: a completed pass leaves no un-indexed note", async () => {
  for (let i = 0; i < 12; i++) {
    fv.put({ id: `n${i}`, content: `body ${i}`, path: `p${i}`, metadata: null, tags: [] });
  }
  await runIndexOnce();
  const model = getEmbedder().id;
  const missing = [...fv.notes.keys()].filter((id) => !indexedHash(id, model));
  assert.deepEqual(missing, [], "every live note has vectors after one pass");
  assert.equal(await runIndexOnce(), 0, "and the next pass has nothing to do");
});

test("a note added after the cursor advanced is still picked up", async () => {
  fv.put({ id: "first", content: "one", path: "a", metadata: null, tags: [], updatedAt: "2026-05-01T00:00:00Z" });
  await runIndexOnce();
  // Backdated on purpose: older than the cursor, so a timestamp-only sweep would
  // never see it. The missing-from-index clause must catch it anyway.
  fv.put({ id: "backdated", content: "two", path: "b", metadata: null, tags: [], updatedAt: "2026-01-01T00:00:00Z" });
  assert.equal(await runIndexOnce(), 1, "indexed despite being older than the cursor");
  assert.ok(indexedHash("backdated", getEmbedder().id));
});

test("an empty note is not re-selected forever once the cursor exists", async () => {
  fv.put({ id: "real", content: "has words", path: "a", metadata: null, tags: [] });
  fv.put({ id: "blank", content: "", path: "b", metadata: null, tags: [] });
  await runIndexOnce(); // establishes the cursor and learns "blank" is empty
  const model = getEmbedder().id;
  assert.equal(indexedHash("blank", model), null, "an empty note has no vectors, by design");

  // Without the empty-note memo, "missing from the index" would re-fetch it on
  // every single pass for the life of the process.
  const callsBefore = fv.calls.length;
  await runIndexOnce();
  const refetched = fv.calls.slice(callsBefore).filter((c) => JSON.stringify(c).includes("blank"));
  assert.equal(refetched.length, 0, "the empty note was not fetched again");
});

test("deletion cleanup collects orphans left by a PREVIOUS embedder model", async () => {
  // The exact shape that stranded 2 notes after the nomic switch: a note deleted
  // from the vault, whose only rows are under the old model. A model-scoped scan
  // cannot see them, so they survive every sweep forever.
  const stale = new Float32Array([1, 0, 0, 0]);
  upsertNoteChunks("ghost-note", "hash-abc", "hash:384", [{ idx: 0, text: "gone", vec: stale }]);
  assert.ok(db.prepare("SELECT 1 FROM embeddings_v2 WHERE note_id = ?").get("ghost-note"), "seeded");

  fv.put({ id: "live", content: "still here", path: "a", metadata: null, tags: [] });
  await runIndexOnce(); // "ghost-note" is not in the vault → must be collected

  assert.equal(
    db.prepare("SELECT 1 FROM embeddings_v2 WHERE note_id = ?").get("ghost-note"),
    undefined,
    "old-model orphan dropped even though the sweep runs a different model",
  );
  assert.ok(indexedHash("live", getEmbedder().id), "the live note is untouched");
});

test("a capped background inventory cannot delete unseen index entries", async () => {
  upsertNoteChunks("unseen", "saved", "old-model", [{idx:0,text:"retained",vec:new Float32Array([1,0])}]);
  const original = globalThis.fetch;
  globalThis.fetch = async (input,init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/notes")) return Response.json(Array.from({length:50_000},(_,i)=>({id:String(i)})));
    return original(input,init);
  };
  try {
    await assert.rejects(runIndexOnce(),/inventory reached its limit/);
    assert.equal(indexedHash("unseen","old-model"),"saved");
  } finally { globalThis.fetch = original; }
});

test("semantic search never returns a removed indexed passage after the note changes", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(OWNER));
  fv.put({ id: "edited", content: "PRIVATE_OLD_PASSAGE soil regenerative details", tags: ["shared"] });
  await app.request("/api/index/rebuild", { method: "POST", headers: { cookie } });
  fv.notes.get("edited")!.content = "Published soil summary with current information.";
  const response = await app.request("/api/search/semantic?q=soil", { headers: { cookie } });
  const hits = await response.json() as Array<{ id: string; _snippet: string }>;
  assert.equal(hits[0]?.id, "edited", "fresh keyword result is retained");
  assert.match(hits[0]!._snippet, /Published soil summary/);
  assert.ok(!JSON.stringify(hits).includes("PRIVATE_OLD_PASSAGE"));
  const obsolete = await app.request("/api/search/semantic?q=PRIVATE_OLD_PASSAGE", { headers: { cookie } });
  assert.deepEqual(await obsolete.json(), [], "stale dense-only matches are excluded");
});

test("hidden semantic hits do not consume the visible result limit", async () => {
  const app = createApp();
  const cookie = sessionCookie(makeSession(OWNER));
  fv.put({ id: "hidden", content: "soil soil regenerative", tags: ["private"] });
  fv.put({ id: "visible", content: "community planning around soil", tags: ["shared"] });
  await app.request("/api/index/rebuild", { method: "POST", headers: { cookie } });
  grantUser("reader@test.local", "tag", "shared", "view");
  const result = await app.request("/api/search/semantic?q=soil&limit=1", { headers: { cookie: sessionCookie(makeSession("reader@test.local")) } });
  assert.deepEqual((await result.json() as Array<{ id: string }>).map(hit => hit.id), ["visible"]);
});

test("index namespaces isolate identical note IDs across vaults, models and chunkers", () => {
  const vec = new Float32Array([1, 0]);
  const a = { vaultId: "a", chunker: CHUNKER_ID }, b = { ...a, vaultId: "b" }, next = { ...a, chunker: "next" };
  for (const [scope, model, text] of [[a, "model", "A"], [b, "model", "B"], [next, "model", "NEXT"], [a, "other-model", "MODEL"]] as const) {
    upsertNoteChunks("same-note", text, model, [{ idx: 0, text, vec }], scope);
  }
  assert.deepEqual(queryTopK("model", vec, 10, a).map(hit => hit.text), ["A"]);
  assert.deepEqual(queryTopK("model", vec, 10, b).map(hit => hit.text), ["B"]);
  assert.deepEqual(queryTopK("model", vec, 10, next).map(hit => hit.text), ["NEXT"]);
  assert.deepEqual(queryTopK("other-model", vec, 10, a).map(hit => hit.text), ["MODEL"]);
  assert.deepEqual(queryTopK("model", new Float32Array([1, 0, 0]), 10, a), []);
  removeNoteChunks("same-note", a);
  assert.deepEqual(queryTopK("model", vec, 10, a), []);
  assert.deepEqual(queryTopK("model", vec, 10, next), []);
  assert.deepEqual(queryTopK("other-model", vec, 10, a), []);
  assert.equal(queryTopK("model", vec, 10, b)[0]?.text, "B");
});

test("legacy index migration is additive, atomic and never resurrects removed rows", () => {
  const copy = new Database(":memory:");
  try {
    copy.exec(`CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY, note_id TEXT, idx INTEGER, model TEXT, dim INTEGER, vec BLOB, text TEXT, content_hash TEXT, updated_at INTEGER)`);
    copy.prepare("INSERT INTO embeddings VALUES (?,?,?,?,?,?,?,?,?)").run("note#0", "note", 0, "model", 2, Buffer.from(new Float32Array([1, 0]).buffer), "legacy", "hash", 1);
    initializeScopedIndex(copy, "original-vault");
    assert.deepEqual(copy.prepare("SELECT vault_id, chunker, text FROM embeddings_v2").all(), [{ vault_id: "original-vault", chunker: CHUNKER_ID, text: "legacy" }]);
    assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n, 1, "rollback index retained");
    copy.exec("DELETE FROM embeddings_v2");
    initializeScopedIndex(copy, "another-default");
    assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM embeddings_v2").get() as { n: number }).n, 0, "one-time migration cannot revive an obsolete row into a changed default");
    assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  } finally { copy.close(); }
});

test("an invalid legacy row rolls back the entire index migration", () => {
  const copy = new Database(":memory:");
  try {
    copy.exec(`CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY, note_id TEXT, idx INTEGER, model TEXT, dim INTEGER, vec BLOB, text TEXT, content_hash TEXT, updated_at INTEGER)`);
    copy.prepare("INSERT INTO embeddings VALUES (?,?,?,?,?,?,?,?,?)").run("invalid#0", "invalid", 0, null, 2, Buffer.alloc(8), "text", "hash", 1);
    assert.throws(() => initializeScopedIndex(copy, "primary"), /NOT NULL/);
    assert.equal(copy.prepare("SELECT name FROM sqlite_master WHERE name='embeddings_v2'").get(), undefined);
    assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n, 1);
  } finally { copy.close(); }
});
