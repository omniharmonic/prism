/**
 * Single-server vault-to-vault folder sync (worker/vault-mirror.ts + /acl/mirrors).
 *
 * The engine tests drive syncMirror with two in-memory vaults and prove the
 * contract: folder structure (paths) is preserved via prefix rebasing; the pass
 * is idempotent (zero writes when nothing changed); edits/moves propagate;
 * deletes are VERIFIED (a listing hiccup never deletes) and archive by default;
 * native destination notes and other mirrors' copies are never touched; a
 * mirrored copy is never re-mirrored (echo guard). Route tests drive the real
 * owner-gated /acl/mirrors CRUD + on-demand sync through the fake vault.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, installFakeVault, type FakeVault } from "./helpers";
import { addVaultEntry, createVaultMirror, getVaultMirror, listVaultMirrors, type VaultMirror } from "../src/db";
import { syncMirror, rebasePath, mirrorSourceKey, type MirrorVault } from "../src/worker/vault-mirror";
import { pathInPrefix } from "../src/paths";

// ── in-memory MirrorVault fake ────────────────────────────────────────────────

interface MemNote {
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
  tags: string[] | null;
}

interface MemVault extends MirrorVault {
  notes: Map<string, MemNote>;
  writes: number; // create + update + delete + tag ops
  hiddenFromListing: Set<string>; // simulate an incomplete listing
  put(n: Partial<MemNote> & { id: string }): MemNote;
}

let seq = 0;
function memVault(): MemVault {
  const v: MemVault = {
    notes: new Map(),
    writes: 0,
    hiddenFromListing: new Set(),
    put(n) {
      const note: MemNote = { content: "", metadata: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: [], ...n, path: n.path ?? null };
      v.notes.set(note.id, note);
      return note;
    },
    async listNotes({ pathPrefix }) {
      return [...v.notes.values()].filter((n) => !v.hiddenFromListing.has(n.id) && (!pathPrefix || pathInPrefix(n.path, pathPrefix)));
    },
    async getNote(id) {
      const n = v.notes.get(id);
      if (!n) throw Object.assign(new Error(`GET /notes/${id}: 404`), { status: 404 });
      return n;
    },
    async createNote(params) {
      v.writes++;
      return v.put({ id: `m-${++seq}`, content: params.content, path: params.path ?? null, metadata: params.metadata ?? null, tags: params.tags ?? [] });
    },
    async updateNote(id, params) {
      v.writes++;
      const n = await v.getNote(id);
      if (params.content !== undefined) n.content = params.content;
      if (params.path !== undefined) n.path = params.path;
      if (params.metadata !== undefined) n.metadata = params.metadata;
      n.updatedAt = `2026-06-01T00:00:${String(seq++).padStart(2, "0")}Z`;
      return n;
    },
    async addTags(id, tags) {
      v.writes++;
      const n = await v.getNote(id);
      n.tags = [...new Set([...(n.tags ?? []), ...tags])];
    },
    async removeTags(id, tags) {
      v.writes++;
      const n = await v.getNote(id);
      n.tags = (n.tags ?? []).filter((t) => !tags.includes(t));
    },
    async deleteNote(id) {
      v.writes++;
      if (!v.notes.delete(id)) throw Object.assign(new Error("404"), { status: 404 });
    },
  };
  return v;
}

const mkCfg = (p: Partial<VaultMirror> = {}): VaultMirror => ({
  id: "mir-1",
  src_vault: "personal",
  src_prefix: "sfr",
  dest_vault: "commons",
  dest_prefix: "frontrange/sfr",
  enabled: true,
  delete_mode: "archive",
  created_by: null,
  created_at: 0,
  last_run_at: null,
  last_result: null,
  ...p,
});

const dstByMarker = (dst: MemVault, marker: string): MemNote | undefined =>
  [...dst.notes.values()].find((n) => n.metadata?.mirror_source === marker);

// ── engine ────────────────────────────────────────────────────────────────────

test("rebasePath preserves the relative folder structure", () => {
  assert.equal(rebasePath("sfr/projects/water/plan", "sfr", "frontrange/sfr"), "frontrange/sfr/projects/water/plan");
  assert.equal(rebasePath("sfr", "sfr", "frontrange/sfr"), "frontrange/sfr"); // note AT the prefix
});

test("initial sync mirrors the whole tree with structure, content, tags and markers", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/readme", content: "root doc", tags: ["page"] });
  src.put({ id: "b", path: "sfr/projects/water/plan", content: "the plan", tags: ["project"], updatedAt: "2026-02-02T00:00:00Z" });
  src.put({ id: "c", path: "sfr/projects/air", content: "air" });
  src.put({ id: "x", path: "elsewhere/nope", content: "outside the folder" });

  const res = await syncMirror(src, dst, mkCfg());
  assert.deepEqual([res.created, res.updated, res.deleted, res.errors.length], [3, 0, 0, 0]);

  const plan = dstByMarker(dst, "personal:b")!;
  assert.equal(plan.path, "frontrange/sfr/projects/water/plan", "nested path rebased, folders intact");
  assert.equal(plan.content, "the plan");
  assert.deepEqual(plan.tags, ["project"]);
  assert.equal(plan.metadata?.mirror_source_updated_at, "2026-02-02T00:00:00Z");
  assert.equal(plan.metadata?.mirror_id, "mir-1");
  assert.ok(!dstByMarker(dst, "personal:x"), "notes outside the prefix are not mirrored");
});

test("a second pass with no source changes makes ZERO destination writes", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/one", content: "1" });
  src.put({ id: "b", path: "sfr/deep/two", content: "2" });
  await syncMirror(src, dst, mkCfg());
  const before = dst.writes;
  const res = await syncMirror(src, dst, mkCfg());
  assert.equal(dst.writes, before, "idempotent — no vault writes");
  assert.deepEqual([res.created, res.updated, res.skipped], [0, 0, 2]);
});

test("source edits and tag changes propagate", async () => {
  const src = memVault();
  const dst = memVault();
  const note = src.put({ id: "a", path: "sfr/doc", content: "v1", tags: ["draft"] });
  await syncMirror(src, dst, mkCfg());

  note.content = "v2";
  note.tags = ["published"];
  note.updatedAt = "2026-03-03T00:00:00Z";
  const res = await syncMirror(src, dst, mkCfg());
  assert.equal(res.updated, 1);
  const copy = dstByMarker(dst, "personal:a")!;
  assert.equal(copy.content, "v2");
  assert.deepEqual(copy.tags, ["published"]);
});

test("moves/renames inside the folder propagate as path updates", async () => {
  const src = memVault();
  const dst = memVault();
  const note = src.put({ id: "a", path: "sfr/inbox/idea", content: "x" });
  await syncMirror(src, dst, mkCfg());

  note.path = "sfr/projects/idea"; // moved to another subfolder, content unchanged
  const res = await syncMirror(src, dst, mkCfg());
  assert.equal(res.updated, 1);
  assert.equal(dstByMarker(dst, "personal:a")!.path, "frontrange/sfr/projects/idea");
});

test("native destination notes under the prefix are never touched", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/doc", content: "mirrored" });
  const native = dst.put({ id: "n", path: "frontrange/sfr/local-note", content: "commons-only" });
  await syncMirror(src, dst, mkCfg());
  // Delete the source note entirely; the native note must survive every mode.
  src.notes.delete("a");
  await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));
  assert.equal(dst.notes.get("n"), native);
  assert.equal(native.content, "commons-only");
});

test("verified delete: archive mode moves the copy under _archive (once)", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/projects/old", content: "x" });
  await syncMirror(src, dst, mkCfg());

  src.notes.delete("a");
  const res = await syncMirror(src, dst, mkCfg());
  assert.equal(res.archived, 1);
  const copy = dstByMarker(dst, "personal:a")!;
  assert.equal(copy.path, "frontrange/sfr/_archive/projects/old", "archived with its relative structure");

  const before = dst.writes;
  await syncMirror(src, dst, mkCfg());
  assert.equal(dst.writes, before, "already-archived copies are not re-archived");
});

test("verified delete: 'delete' hard-deletes, 'keep' never touches", async () => {
  for (const [mode, survives] of [["delete", false], ["keep", true]] as const) {
    const src = memVault();
    const dst = memVault();
    src.put({ id: "a", path: "sfr/doc", content: "x" });
    await syncMirror(src, dst, mkCfg({ delete_mode: mode }));
    src.notes.delete("a");
    await syncMirror(src, dst, mkCfg({ delete_mode: mode }));
    assert.equal(!!dstByMarker(dst, "personal:a"), survives, `delete_mode=${mode}`);
  }
});

test("a listing hiccup is NOT a deletion — the copy stays put", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/doc", content: "x" });
  await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));

  src.hiddenFromListing.add("a"); // absent from the listing, but getNote still finds it
  const res = await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));
  assert.equal(res.deleted, 0);
  assert.ok(dstByMarker(dst, "personal:a"), "copy kept — source is alive");
});

test("delete-verify failure (non-404) fails closed and is reported", async () => {
  const src = memVault();
  const dst = memVault();
  src.put({ id: "a", path: "sfr/doc", content: "x" });
  await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));

  src.notes.delete("a");
  src.getNote = async () => {
    throw Object.assign(new Error("vault down"), { status: 503 });
  };
  const res = await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));
  assert.equal(res.deleted, 0);
  assert.equal(res.errors.length, 1);
  assert.ok(dstByMarker(dst, "personal:a"), "outage must never look like a deletion");
});

test("echo guard: a mirrored copy is never re-mirrored (A→B + B→A cannot ping-pong)", async () => {
  const a = memVault();
  const b = memVault();
  a.put({ id: "orig", path: "sfr/doc", content: "x" });
  await syncMirror(a, b, mkCfg({ id: "ab", src_vault: "A", src_prefix: "sfr", dest_vault: "B", dest_prefix: "shared/sfr" }));
  const back = await syncMirror(b, a, mkCfg({ id: "ba", src_vault: "B", src_prefix: "shared/sfr", dest_vault: "A", dest_prefix: "sfr" }));
  assert.deepEqual([back.created, back.updated], [0, 0], "the copy in B is skipped as a source");
  assert.equal(a.notes.size, 1, "nothing echoed back into A");
});

test("other mirrors' copies in the same destination folder are not managed", async () => {
  const src = memVault();
  const dst = memVault();
  dst.put({ id: "other", path: "frontrange/sfr/from-elsewhere", content: "y", metadata: { mirror_source: "other-vault:z", mirror_id: "another-mirror" } });
  const res = await syncMirror(src, dst, mkCfg({ delete_mode: "delete" }));
  assert.equal(res.deleted, 0);
  assert.ok(dst.notes.get("other"), "another mirror's copy survives");
});

// ── routes ────────────────────────────────────────────────────────────────────

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));
let fv: FakeVault;

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  addVaultEntry({ id: "commons", label: "Front Range Commons", url: "http://vault.test", vault: "default", token: "t" });
});

const postMirror = (cookie: string, body: Record<string, unknown>) =>
  acl.request("/mirrors", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify(body) });

test("POST /acl/mirrors validates vaults, prefixes and overlap", async () => {
  const cookie = ownerCookie();
  assert.equal((await postMirror(cookie, { srcVault: "primary", srcPrefix: "sfr", destVault: "ghost", destPrefix: "x" })).status, 400, "unknown vault");
  assert.equal((await postMirror(cookie, { srcVault: "primary", srcPrefix: "../etc", destVault: "commons", destPrefix: "x" })).status, 400, "traversal prefix");
  assert.equal((await postMirror(cookie, { srcVault: "primary", srcPrefix: "sfr", destVault: "primary", destPrefix: "sfr/copy" })).status, 400, "self-feeding overlap");
  assert.equal((await postMirror(cookie, { srcVault: "primary", srcPrefix: "sfr", destVault: "commons", destPrefix: "frc/sfr", deleteMode: "nuke" })).status, 400, "bad delete mode");

  const r = await postMirror(cookie, { srcVault: "primary", srcPrefix: "/sfr/", destVault: "commons", destPrefix: "frc//sfr" });
  assert.equal(r.status, 200);
  const m = (await r.json()) as { id: string; src_prefix: string; dest_prefix: string; enabled: boolean; delete_mode: string };
  assert.equal(m.src_prefix, "sfr", "prefix normalized");
  assert.equal(m.dest_prefix, "frc/sfr");
  assert.deepEqual([m.enabled, m.delete_mode], [true, "archive"]);
  assert.equal(listVaultMirrors().length, 1);
});

test("mirrors CRUD is owner/admin-gated", async () => {
  const rando = sessionCookie(makeSession("rando@example.com"));
  assert.equal((await acl.request("/mirrors", { headers: { cookie: rando } })).status, 403);
  assert.equal((await postMirror(rando, { srcVault: "primary", srcPrefix: "sfr", destVault: "commons", destPrefix: "frc/sfr" })).status, 403);
});

test("PATCH toggles enabled/delete_mode; DELETE removes; unknown ids 404", async () => {
  const cookie = ownerCookie();
  const m = (await (await postMirror(cookie, { srcVault: "primary", srcPrefix: "sfr", destVault: "commons", destPrefix: "frc/sfr" })).json()) as { id: string };
  const patched = (await (
    await acl.request(`/mirrors/${m.id}`, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ enabled: false, deleteMode: "keep" }) })
  ).json()) as { enabled: boolean; delete_mode: string };
  assert.deepEqual([patched.enabled, patched.delete_mode], [false, "keep"]);

  assert.equal((await acl.request("/mirrors/nope", { method: "PATCH", headers: { ...J, cookie }, body: "{}" })).status, 404);
  assert.equal((await acl.request(`/mirrors/${m.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal(getVaultMirror(m.id), null);
});

test("POST /acl/mirrors/:id/sync mirrors a folder end-to-end through the vault API", async () => {
  const cookie = ownerCookie();
  fv.put({ id: "s1", path: "sfr/readme", content: "hello", tags: ["page"] });
  fv.put({ id: "s2", path: "sfr/projects/water", content: "plan", tags: [] });
  fv.put({ id: "s3", path: "private/secret", content: "not shared", tags: [] });

  const m = (await (await postMirror(cookie, { srcVault: "primary", srcPrefix: "sfr", destVault: "commons", destPrefix: "frc/sfr" })).json()) as { id: string };
  const r = await acl.request(`/mirrors/${m.id}/sync`, { method: "POST", headers: { cookie } });
  assert.equal(r.status, 200);
  const { result } = (await r.json()) as { result: { created: number; errors: string[] } };
  assert.equal(result.created, 2);
  assert.deepEqual(result.errors, []);

  // Both registry entries point at the same fake vault store, so the mirrored
  // copies land beside the sources — with rebased paths and markers.
  const all = [...fv.notes.values()];
  const copy = all.find((n) => n.metadata?.mirror_source === mirrorSourceKey("primary", "s2"));
  assert.ok(copy, "copy created via the real vault HTTP surface");
  assert.equal(copy!.path, "frc/sfr/projects/water");
  assert.ok(!all.some((n) => n.metadata?.mirror_source === mirrorSourceKey("primary", "s3")), "outside the prefix — never mirrored");

  // A second forced run is a no-op (idempotent through the HTTP path too).
  const again = (await (await acl.request(`/mirrors/${m.id}/sync`, { method: "POST", headers: { cookie } })).json()) as {
    result: { created: number; updated: number; skipped: number };
  };
  assert.deepEqual([again.result.created, again.result.updated, again.result.skipped], [0, 0, 2]);

  // The run summary landed on the row.
  const row = getVaultMirror(m.id)!;
  assert.ok(row.last_run_at, "last_run_at recorded");
  assert.equal((JSON.parse(row.last_result!) as { created: number }).created, 0);
});
