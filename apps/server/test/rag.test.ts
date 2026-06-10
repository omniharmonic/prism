/**
 * RAG: unit coverage for chunking / embedding / fusion / store, plus end-to-end
 * coverage of the /api/search/semantic + /api/index/* routes through the REAL
 * app pipeline (actor resolution + authorization), with a fake vault and the
 * deterministic offline HashEmbedder (no model/network needed).
 */
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

const OWNER = "owner@test.local"; // matches .env.test OWNER_EMAIL

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  db.exec("DELETE FROM embeddings");
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
