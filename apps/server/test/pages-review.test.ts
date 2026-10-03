/**
 * Review fixes for the pages API (feat/ux-pages-nav review: H1–H3, M1–M6, lock, lows).
 * Through the real gateway app + fake vault. Each block pins one finding.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { api } from "../src/routes/api";
import { publish } from "../src/routes/publish";
import { resetTreeForTests } from "../src/tree";
import { runTrashPurgeOnce, resetPagesForTests, trashLedger } from "../src/pages";
import { createPublication, createVaultMirror, db } from "../src/db";
import { insertGitHubConfig } from "../src/worker/sync-store";
import { viewableBy } from "../src/worker/sync-visibility";
import { publicationInventory } from "../src/publication-content";
import { hocuspocus, resolveLevel, authorizeConnection } from "../src/collab";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
import { TRASH_TAG } from "@prism/core/pages";

let fv: FakeVault;
const OWNER = "owner@test.local";
const J = { "content-type": "application/json" };

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
  delete process.env.TRASH_PURGE_ENABLED;
});

function req(path: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const as = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, cookie: string) => req(path, { method: "POST", cookie, headers: J, body: JSON.stringify(body) });
const patch = (id: string, body: unknown, cookie: string) => req(`/notes/${id}`, { method: "PATCH", cookie, headers: J, body: JSON.stringify(body) });
const stamp = (id: string) => fv.notes.get(id)!.updatedAt;

// ── H1: trashed pages leave folder publications, GitHub/Notion sync and mirrors ─
test("H1: a trashed page is not public on a FOLDER publication nor exported by sync/mirror", async () => {
  fv.put({ id: "pub", path: "Site/Page", content: "<p>x</p>", tags: [TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00.000Z" } });
  fv.put({ id: "ok", path: "Site/Other", content: "<p>y</p>", tags: [] });
  const pub = createPublication({ id: "site", resource_type: "path", resource: "Site", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  const inv = await publicationInventory(pub);
  assert.deepEqual(inv.candidates.map((n) => n.id), ["ok"]);
  const single = await publish.request(`/site/notes/pub`);
  assert.equal(single.status, 403);
  const note = fv.notes.get("pub")!;
  assert.equal(viewableBy(OWNER, "primary")(note as never), false, "GitHub/Notion export filter drops it");
});

// ── H2: the destination is checked ────────────────────────────────────────────
test("H2: non-owners cannot move into exported folders or under a page they can't organize", async () => {
  fv.put({ id: "mine", path: "Team/Mine", content: "m", tags: ["team"] });
  fv.put({ id: "dest", path: "Team/Dest", content: "d", tags: ["team"] });
  fv.put({ id: "hers", path: "Hers", content: "h", tags: ["hers"] });
  grantUser("org@test.local", "tag", "team", "own");
  const org = as("org@test.local");
  createPublication({ id: "pubd", resource_type: "path", resource: "Published", template: "wiki", title: null, home_note_id: null, password_hash: null, theme: null, expires_at: null, created_by: OWNER } as never);
  fv.put({ id: "pubpage", path: "Published", content: "p", tags: ["team"] });
  assert.equal((await post("/notes/mine/move", { newParentPath: "Published", if_updated_at: stamp("mine") }, org)).status, 403, "into a published folder");
  createVaultMirror({ src_vault: "primary", src_prefix: "Mirrored", dest_vault: "primary", dest_prefix: "Copy" });
  fv.put({ id: "mirpage", path: "Mirrored", content: "p", tags: ["team"] });
  assert.equal((await post("/notes/mine/move", { newParentPath: "Mirrored", if_updated_at: stamp("mine") }, org)).status, 403, "into a mirror source");
  insertGitHubConfig({ vaultId: "primary", vaultPath: "Synced", owner: "o", repo: "r", branch: "main", fileExtension: ".md", commitStrategy: "manual", conflictStrategy: "local-wins", autoSync: true, idMap: {}, blobMap: {}, lastSynced: "", importedFrom: null, createdBy: OWNER });
  fv.put({ id: "synpage", path: "Synced", content: "p", tags: ["team"] });
  assert.equal((await post("/notes/mine/move", { newParentPath: "Synced", if_updated_at: stamp("mine") }, org)).status, 403, "into a GitHub-synced folder");
  assert.equal((await post("/notes/mine/move", { newParentPath: "Hers", if_updated_at: stamp("mine") }, org)).status, 403, "under someone else's page");
  assert.equal((await post("/notes/mine/move", { newParentPath: "", if_updated_at: stamp("mine") }, org)).status, 403, "no parent page → admin only");
  assert.equal((await post("/notes/mine/move", { newParentPath: "Team/Dest", if_updated_at: stamp("mine") }, org)).status, 200, "under a page they organize");
  // The owner may move into exported folders.
  assert.equal((await post("/notes/hers/move", { newParentPath: "Published", if_updated_at: stamp("hers") }, as(OWNER))).status, 200);
});

// ── H3: non-owners cannot forge access/trash metadata ───────────────────────────
test("H3: an editor cannot set prism_creator / visibility / trash metadata via PATCH or /properties", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"], metadata: { prism_creator: "other@test.local" } });
  grantUser("ed@test.local", "tag", "team", "edit");
  const ed = as("ed@test.local");
  for (const meta of [{ prism_creator: "ed@test.local" }, { prism_visibility: "private" }, { prism_trashed_at: "x" }, { prism_trashed_root: "n" }]) {
    assert.equal((await patch("n", { metadata: meta, if_updated_at: stamp("n") }, ed)).status, 403, JSON.stringify(meta));
  }
  assert.equal(fv.notes.get("n")!.metadata!.prism_creator, "other@test.local");
  const props = await post("/properties/n", { set: { prism_trashed_by: "ed@test.local" } }, ed);
  assert.ok([400, 403].includes(props.status), "refused: prism_* keys are never properties");
  assert.equal((await post("/notes/n/trash", {}, ed)).status, 403, "still not the creator");
});

// ── M1: trash is a ledger, not just a tag ────────────────────────────────────
test("M1: non-owners can't toggle the trash tag; purge uses the ledger only", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"], metadata: { prism_creator: "ed@test.local" } });
  grantUser("ed@test.local", "tag", "team", "own");
  const ed = as("ed@test.local");
  assert.equal((await patch("n", { add_tags: [TRASH_TAG] }, ed)).status, 403);
  // A note tagged trashed outside the trash route (e.g. an agent writing the vault) is never purged.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  fv.put({ id: "rogue", path: "Rogue", content: "r", tags: [TRASH_TAG], metadata: { prism_trashed_at: old } });
  assert.equal((await post("/notes/n/trash", {}, ed)).status, 200);
  assert.deepEqual(trashLedger("primary").map((r) => r.note_id), ["n"]);
  // Age the ledger entry, then purge.
  db.prepare("UPDATE page_trash_ledger SET trashed_at = ?").run(old);
  fv.notes.get("n")!.metadata!.prism_trashed_at = old;
  process.env.TRASH_PURGE_ENABLED = "true";
  const out = await runTrashPurgeOnce();
  assert.equal(out.purged, 1);
  assert.ok(fv.notes.has("rogue"), "not in the ledger → kept");
  assert.ok(!fv.notes.has("n"));
  assert.equal(trashLedger("primary").length, 0);
  // Admins see the untracked one.
  const list = (await (await req("/trash", { cookie: as(OWNER) })).json()) as { untracked: Array<{ id: string }> };
  assert.deepEqual(list.untracked.map((u) => u.id), ["rogue"]);
});

test("M1: restore clears the ledger; a protected note in the ledger is never purged", async () => {
  fv.put({ id: "p", path: "P", content: "c", tags: [] });
  const owner = as(OWNER);
  await post("/notes/p/trash", {}, owner);
  assert.equal(trashLedger("primary").length, 1);
  await post("/trash/p/restore", {}, owner);
  assert.equal(trashLedger("primary").length, 0);
  // Hand-made ledger row for a protected note: kept.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  fv.put({ id: "mail", path: "vault/messages/email/x", content: "m", tags: [TRASH_TAG], metadata: { prism_trashed_at: old } });
  db.prepare("INSERT INTO page_trash_ledger (vault_id, note_id, root_id, trashed_at, trashed_by) VALUES ('primary','mail','mail',?, 'x')").run(old);
  process.env.TRASH_PURGE_ENABLED = "true";
  await runTrashPurgeOnce();
  assert.ok(fv.notes.has("mail"));
});

// ── M2: links into a moved page, open live, are stored before the move ───────
test("M2: a live doc linking into the moved page is stored BEFORE the path write", async () => {
  fv.put({ id: "target", path: "Old/Target", content: "<p>t</p>", tags: [], links: [{ sourceId: "src", targetId: "target", relationship: "wikilink" }] });
  fv.put({ id: "src", path: "Src", content: "<p>see [[Old/Target]]</p>", tags: [] });
  const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };
  hocuspocus.configuration.debounce = 60_000;
  hocuspocus.configuration.maxDebounce = 120_000;
  const conn = await hocuspocus.openDirectConnection("src", {});
  try {
    await conn.transact((doc: Y.Doc) => {
      const frag = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("UNSAVED_TYPING")]);
      frag.insert(frag.length, [p]);
    });
    fv.calls.length = 0;
    const r = await post("/notes/target/move", { newParentPath: "New", if_updated_at: stamp("target") }, as(OWNER));
    assert.equal(r.status, 200);
    const writes = fv.calls.filter((c) => c.method === "PATCH").map((c) => c.path.split("/").pop());
    assert.deepEqual(writes, ["src", "target"], "the live source is stored first, then the move");
    assert.match(fv.notes.get("src")!.content, /UNSAVED_TYPING/);
  } finally {
    await conn.disconnect();
    hocuspocus.configuration.debounce = saved.debounce;
    hocuspocus.configuration.maxDebounce = saved.maxDebounce;
  }
});

// ── LOCK: server enforcement ──────────────────────────────────────────────────
test("LOCK: content writes and restores on a locked note → 423; toggling needs organize + CAS", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"] });
  grantUser("ed@test.local", "tag", "team", "edit");
  grantUser("org@test.local", "tag", "team", "own");
  const ed = as("ed@test.local");
  const org = as("org@test.local");
  assert.equal((await post("/notes/n/meta", { set: { prism_locked: true } }, ed)).status, 403, "edit can't lock");
  assert.equal((await post("/notes/n/meta", { set: { prism_locked: true } }, org)).status, 428, "needs if_updated_at");
  assert.equal((await post("/notes/n/meta", { set: { prism_locked: true }, if_updated_at: stamp("n") }, org)).status, 200);
  assert.equal((await patch("n", { content: "changed", if_updated_at: stamp("n") }, ed)).status, 423);
  assert.equal((await patch("n", { metadata: { prism_locked: false }, if_updated_at: stamp("n") }, ed)).status, 403, "editor can't unlock via PATCH");
  assert.equal((await post("/notes/n/restore", { version_ix: 0, if_updated_at: stamp("n") }, ed)).status, 423);
  assert.equal(fv.notes.get("n")!.content, "c");
});

test("LOCK: the collab socket is read-only on a locked note", async () => {
  fv.put({ id: "lk", path: "Team/Lk", content: "<p>x</p>", tags: ["team"], metadata: { prism_locked: true } });
  grantUser("ed@test.local", "tag", "team", "edit");
  const cookie = sessionCookie(makeSession("ed@test.local"));
  assert.equal(await resolveLevel("lk", "session", cookie), "edit");
  const config = { readOnly: false };
  await authorizeConnection("lk", "session", cookie, config);
  assert.equal(config.readOnly, true);
});

// ── M3: metadata-only page writes go through the reconciling pages route ─────
test("M3: reorder via POST /notes/:id/meta is CAS + organize", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"] });
  grantUser("ed@test.local", "tag", "team", "edit");
  assert.equal((await post("/notes/n/meta", { set: { prism_order: 5 } }, as("ed@test.local"))).status, 403);
  assert.equal((await post("/notes/n/meta", { set: { prism_order: 5 }, if_updated_at: stamp("n") }, as(OWNER))).status, 200);
  assert.equal(fv.notes.get("n")!.metadata!.prism_order, 5);
  assert.equal((await post("/notes/n/meta", { set: { title: "x" }, if_updated_at: stamp("n") }, as(OWNER))).status, 400, "only page keys");
});

// ── M4: preferences PUT keeps ids the caller can't see; byte cap streamed ────
test("M4: a PUT never erases favorites the caller cannot currently see", async () => {
  fv.put({ id: "a", path: "Team/A", content: "a", tags: ["team"] });
  fv.put({ id: "b", path: "Secret/B", content: "b", tags: ["secret"] });
  grantUser("ed@test.local", "tag", "team", "edit");
  grantUser("ed@test.local", "tag", "secret", "view");
  const ed = as("ed@test.local");
  await req("/me/preferences", { method: "PUT", cookie: ed, headers: J, body: JSON.stringify({ preferences: { favorites: ["a", "b"] } }) });
  db.prepare("DELETE FROM grants WHERE resource = 'secret'").run();
  const got = (await (await req("/me/preferences", { cookie: ed })).json()) as { preferences: { favorites: string[] }; revision: number };
  assert.deepEqual(got.preferences.favorites, ["a"]);
  await req("/me/preferences", { method: "PUT", cookie: ed, headers: J, body: JSON.stringify({ preferences: { favorites: ["a"] }, ifRevision: got.revision }) });
  grantUser("ed@test.local", "tag", "secret", "view");
  const back = (await (await req("/me/preferences", { cookie: ed })).json()) as { preferences: { favorites: string[] } };
  assert.deepEqual(back.preferences.favorites, ["a", "b"], "the hidden favorite survived the PUT");
  const big = await req("/me/preferences", { method: "PUT", cookie: ed, headers: { ...J, "content-length": "999999" }, body: "x".repeat(70_000) });
  assert.equal(big.status, 413);
});

// ── M5: plans from a fresh listing; partial moves journaled and resumable by id ─
test("M5: move plans from the vault (not a stale tree); partial is journaled and resumed by moveId + CAS", async () => {
  fv.put({ id: "p", path: "A", content: "p", tags: [] });
  fv.put({ id: "c1", path: "A/One", content: "1", tags: [] });
  const owner = as(OWNER);
  await req("/tree", { cookie: owner }); // build the projection BEFORE c2 exists
  fv.put({ id: "c2", path: "A/Two", content: "2", tags: [] }); // the tree does not know c2 (no socket in tests)
  const inner = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (fail && init?.method === "PATCH" && u.endsWith("/notes/c2")) return new Response("boom", { status: 500 });
    return inner(input, init);
  }) as typeof fetch;
  try {
    const r = await post("/notes/p/move", { newParentPath: "B", if_updated_at: stamp("p") }, owner);
    assert.equal(r.status, 207, "c2 came from the fresh listing and failed");
    const body = (await r.json()) as { moveId: string };
    assert.equal(typeof body.moveId, "string");
    const journal = (await (await req("/moves", { cookie: owner })).json()) as { moves: Array<{ id: string; status: string }> };
    assert.deepEqual(journal.moves.map((m) => [m.id, m.status]), [[body.moveId, "partial"]]);
    fail = false;
    assert.equal((await post("/notes/p/move", { moveId: body.moveId, if_updated_at: "2000-01-01T00:00:00.000Z" }, owner)).status, 409, "resume is CAS-bound");
    const resumed = await post("/notes/p/move", { moveId: body.moveId, if_updated_at: stamp("p") }, owner);
    assert.equal(resumed.status, 200);
    assert.equal(fv.notes.get("c2")!.path, "B/A/Two");
    assert.equal((await post("/notes/p/move", { fromPath: "A", newPath: "B/A" }, owner)).status, 400, "bare fromPath resume is gone");
  } finally {
    globalThis.fetch = inner;
  }
});

// ── M6: trashed leaks ─────────────────────────────────────────────────────────
test("M6: wikilink resolve, graph, single-note reads and /query hide trash details", async () => {
  fv.put({ id: "t", path: "Team/Gone", content: "x", tags: ["team", TRASH_TAG], metadata: { prism_trashed_at: "2026-01-01T00:00:00.000Z", prism_trashed_by: "owner@test.local", title: "Gone" } });
  grantUser("viv@test.local", "tag", "team", "view");
  const viv = as("viv@test.local");
  const resolved = (await (await req("/wikilinks/resolve?target=Gone", { cookie: viv })).json()) as { kind: string };
  assert.equal(resolved.kind, "none");
  const one = (await (await req("/notes/t", { cookie: viv })).json()) as { metadata: Record<string, unknown> };
  assert.ok(!("prism_trashed_by" in one.metadata));
  const q = await post("/query", { tags: ["team"] }, viv);
  if (q.status === 200) assert.equal(((await q.json()) as { rows: unknown[] }).rows.length, 0);
});

// ── LOWs ──────────────────────────────────────────────────────────────────────
test("LOW: no existence oracle on a hidden clash; trashed pages can't move; trash clash is named", async () => {
  fv.put({ id: "mine", path: "Team/Mine", content: "m", tags: ["team"] });
  fv.put({ id: "dest", path: "Team/Dest", content: "d", tags: ["team"] });
  fv.put({ id: "hidden", path: "Team/Dest/Mine", content: "h", tags: ["secret"] });
  grantUser("org@test.local", "tag", "team", "own");
  const org = as("org@test.local");
  const r = await post("/notes/mine/move", { newParentPath: "Team/Dest", if_updated_at: stamp("mine") }, org);
  assert.equal(r.status, 409);
  const body = JSON.stringify(await r.json());
  assert.ok(!body.includes("Team/Dest/Mine"), "no path of a note they can't see");
  fv.put({ id: "tr", path: "Team/Tr", content: "t", tags: ["team", TRASH_TAG] });
  assert.equal((await post("/notes/tr/move", { newParentPath: "Team/Dest", if_updated_at: stamp("tr") }, as(OWNER))).status, 409);
  fv.notes.delete("hidden");
  fv.put({ id: "trclash", path: "Team/Dest/Mine", content: "t", tags: ["team", TRASH_TAG] });
  resetTreeForTests();
  const c = await post("/notes/mine/move", { newParentPath: "Team/Dest", if_updated_at: stamp("mine") }, org);
  assert.equal(c.status, 409);
  assert.match(((await c.json()) as { reason: string }).reason, /Trash/);
});

// ── editor-schema gate (main bda65e2) vs the pages routes ─────────────────────
test("pages routes are metadata/path-only: they never trip the editor-schema gate", async () => {
  const v2 = '<div data-type="callout"><p>new block</p></div>';
  fv.put({ id: "p", path: "Team/P", content: v2, tags: ["team"] });
  fv.put({ id: "c", path: "Team/P/Child", content: v2, tags: ["team"] });
  fv.put({ id: "d", path: "Team/Dest", content: "d", tags: ["team"] });
  const owner = as(OWNER);
  // No X-Prism-Editor-Schema header on any of these.
  assert.equal((await post("/notes/p/meta", { set: { prism_order: 3 }, if_updated_at: stamp("p") }, owner)).status, 200);
  assert.equal((await post("/notes/p/meta", { set: { prism_locked: true }, if_updated_at: stamp("p") }, owner)).status, 200);
  assert.equal((await post("/notes/p/meta", { set: { prism_locked: false }, if_updated_at: stamp("p") }, owner)).status, 200);
  assert.equal((await post("/notes/p/move", { newParentPath: "Team/Dest", if_updated_at: stamp("p") }, owner)).status, 200);
  assert.equal((await post("/notes/p/trash", {}, owner)).status, 200);
  assert.equal((await post("/trash/p/restore", {}, owner)).status, 200);
  assert.equal(fv.notes.get("p")!.content, v2, "content untouched");
  // …while a header-less CONTENT write to the same note is still gated.
  assert.equal((await patch("p", { content: "<p>old editor</p>", if_updated_at: stamp("p") }, owner)).status, 409);
});
