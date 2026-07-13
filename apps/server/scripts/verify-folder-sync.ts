/**
 * verify-folder-sync.ts — end-to-end proof of single-server vault-to-vault
 * folder sync against REAL Parachute vaults. SCRATCH VAULTS ONLY: it creates
 * two throwaway vaults (`_mirror_a_*`, `_mirror_b_*`) via the parachute-vault
 * CLI, drives the syncMirror engine between them over the live REST API, and
 * removes both vaults in teardown. It never reads or writes any existing vault,
 * and it never touches the Prism server's SQLite (the engine module is pure —
 * see the header in src/worker/vault-mirror.ts).
 *
 * Proves, in order:
 *   1. a nested folder tree under the source prefix lands in the destination
 *      vault with its structure intact (paths rebased, content/tags/markers on)
 *   2. a second pass is a no-op (idempotent)
 *   3. a source EDIT propagates
 *   4. a source MOVE (folder-to-folder) propagates as a path update
 *   5. a source DELETE is verified then ARCHIVED under <dest>/_archive/
 *   6. notes outside the prefix, and native destination notes, are untouched
 *   7. the destination note set derives the same folder tree a collaborator's
 *      sidebar would build (folders ARE paths — this is the visibility proof)
 *
 * Usage: node --env-file=.env --import tsx scripts/verify-folder-sync.ts
 * (only PARACHUTE_URL is read from the env; defaults to http://localhost:1940)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncMirror, type MirrorVault } from "../src/worker/vault-mirror";
import type { VaultMirror } from "../src/db";
import type { Note } from "../src/parachute";

const pexec = promisify(execFile);
const HUB = (process.env.PARACHUTE_URL ?? "http://localhost:1940").replace(/\/+$/, "");

// ── accounting (verify-crdt-conflict.ts idiom) ────────────────────────────────
let pass = 0;
let fail = 0;
function rec(ok: boolean, label: string, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── scratch vault lifecycle ───────────────────────────────────────────────────
interface Scratch {
  name: string;
  token: string;
}

async function createScratchVault(prefix: string): Promise<Scratch> {
  const name = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
  const { stdout } = await pexec("parachute-vault", ["create", name, "--mint", "--scope", "write", "--no-mirror", "--json"]);
  const parsed = JSON.parse(stdout) as { name: string; token: string };
  if (!parsed?.token) throw new Error(`vault create for ${name} returned no token`);
  return { name: parsed.name, token: parsed.token };
}

async function removeScratchVault(name: string): Promise<void> {
  try {
    await pexec("parachute-vault", ["remove", name, "--yes"]);
    console.log(`  cleaned up scratch vault ${name}`);
  } catch (e) {
    console.error(`  WARNING: could not remove scratch vault ${name}: ${(e as Error).message}`);
  }
}

/** Minimal MirrorVault over the live REST API (mirrors src/parachute.ts shapes,
 *  but self-contained — no server config/db). Errors carry .status for the
 *  engine's verified-delete check. */
function liveVault(v: Scratch): MirrorVault & { list(): Promise<Note[]> } {
  const base = `${HUB}/vault/${v.name}/api`;
  const headers = { Authorization: `Bearer ${v.token}`, "Content-Type": "application/json" };
  async function req(path: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(`${base}${path}`, { ...init, headers });
    if (!resp.ok) {
      throw Object.assign(new Error(`${init?.method ?? "GET"} ${path}: ${resp.status}`), { status: resp.status });
    }
    return resp;
  }
  return {
    async listNotes({ pathPrefix, includeContent }: { pathPrefix?: string; includeContent?: boolean }) {
      const sp = new URLSearchParams({ limit: "50000" });
      if (pathPrefix) sp.set("path_prefix", pathPrefix);
      if (includeContent) sp.set("include_content", "true");
      return (await req(`/notes?${sp}`)).json() as Promise<Note[]>;
    },
    list() {
      // include_content so the ASSERTIONS can inspect content; the engine's own
      // listings deliberately skip it (it re-fetches full notes only on change).
      return this.listNotes({ includeContent: true });
    },
    async getNote(id: string) {
      return (await req(`/notes/${encodeURIComponent(id)}`)).json() as Promise<Note>;
    },
    async createNote(params) {
      return (await req(`/notes`, { method: "POST", body: JSON.stringify(params) })).json() as Promise<Note>;
    },
    async updateNote(id, params) {
      return (await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...params, force: true }) })).json() as Promise<Note>;
    },
    async addTags(id, tags) {
      await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ tags: { add: tags }, force: true }) });
    },
    async removeTags(id, tags) {
      await req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ tags: { remove: tags }, force: true }) });
    },
    async deleteNote(id) {
      await req(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

/** The folder tree a client sidebar derives from a note set: every ancestor
 *  directory of every note path (exactly what ProjectTree.buildTree walks). */
function folderTreeOf(notes: Note[], underPrefix: string): Set<string> {
  const dirs = new Set<string>();
  for (const n of notes) {
    if (!n.path?.startsWith(`${underPrefix}/`)) continue;
    const segs = n.path.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  return dirs;
}

const cfg: VaultMirror = {
  id: "verify-mirror",
  src_vault: "scratch-a",
  src_prefix: "sfr",
  dest_vault: "scratch-b",
  dest_prefix: "frontrange/sfr",
  enabled: true,
  delete_mode: "archive",
  created_by: null,
  created_at: 0,
  last_run_at: null,
  last_result: null,
};

async function main(): Promise<void> {
  console.log(`verify-folder-sync against ${HUB}`);
  const health = await fetch(`${HUB}/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`Parachute hub not reachable at ${HUB}`);

  console.log("— creating scratch vaults");
  const a = await createScratchVault("_mirror_a_");
  const b = await createScratchVault("_mirror_b_");
  console.log(`  ${a.name} (source) / ${b.name} (destination)`);

  try {
    const va = liveVault(a);
    const vb = liveVault(b);

    // Seed the source: a nested "Spirit of the Front Range" folder + a private note.
    const readme = await va.createNote({ content: "# Spirit of the Front Range\n\nShared commons folder.", path: "sfr/readme", tags: ["page"] });
    const plan = await va.createNote({ content: "# Watershed plan\n\nv1", path: "sfr/projects/water/plan", tags: ["project"] });
    await va.createNote({ content: "# Air quality notes", path: "sfr/projects/air-quality", tags: [] });
    await va.createNote({ content: "keep out", path: "private/secret", tags: [] });
    // A native note already living in the destination folder.
    const native = await vb.createNote({ content: "commons-only note", path: "frontrange/sfr/local-note", tags: [] });

    // 1) initial sync: full tree with structure
    console.log("— 1) initial sync");
    let res = await syncMirror(va, vb, cfg);
    rec(res.created === 3 && res.errors.length === 0, `3 notes mirrored (created=${res.created}, errors=${res.errors.join("; ") || "none"})`);
    let bNotes = await vb.list();
    const paths = new Set(bNotes.map((n) => n.path));
    rec(paths.has("frontrange/sfr/readme"), "root note at the destination prefix");
    rec(paths.has("frontrange/sfr/projects/water/plan"), "deep nested path preserved");
    rec(paths.has("frontrange/sfr/projects/air-quality"), "sibling folder preserved");
    rec(!([...paths].some((p) => p?.includes("secret"))), "note outside the prefix NOT mirrored");
    const planCopy = bNotes.find((n) => n.path === "frontrange/sfr/projects/water/plan");
    rec(planCopy?.content?.includes("Watershed plan") === true, "content mirrored");
    rec((planCopy?.tags ?? []).includes("project"), "tags mirrored");
    rec(planCopy?.metadata?.mirror_source === `scratch-a:${plan.id}`, "identity marker set");

    // 2) idempotent
    console.log("— 2) idempotency");
    res = await syncMirror(va, vb, cfg);
    rec(res.created === 0 && res.updated === 0 && res.skipped === 3, `second pass is a no-op (skipped=${res.skipped})`);

    // 3) edit propagates
    console.log("— 3) edit propagation");
    await va.updateNote(plan.id, { content: "# Watershed plan\n\nv2 — revised" });
    res = await syncMirror(va, vb, cfg);
    const planCopy2 = (await vb.list()).find((n) => n.metadata?.mirror_source === `scratch-a:${plan.id}`);
    rec(res.updated === 1 && planCopy2?.content?.includes("v2 — revised") === true, "source edit reached the destination copy");

    // 4) move propagates
    console.log("— 4) move propagation");
    await va.updateNote(plan.id, { path: "sfr/projects/watershed/plan" });
    res = await syncMirror(va, vb, cfg);
    const moved = (await vb.list()).find((n) => n.metadata?.mirror_source === `scratch-a:${plan.id}`);
    rec(moved?.path === "frontrange/sfr/projects/watershed/plan", `folder-to-folder move propagated (${moved?.path})`);

    // 5) verified delete → archive
    console.log("— 5) verified delete (archive mode)");
    await va.deleteNote(readme.id);
    res = await syncMirror(va, vb, cfg);
    const archived = (await vb.list()).find((n) => n.metadata?.mirror_source === `scratch-a:${readme.id}`);
    rec(res.archived === 1 && archived?.path === "frontrange/sfr/_archive/readme", `deleted source archived, nothing destroyed (${archived?.path})`);

    // 6) native destination note untouched
    console.log("— 6) native notes");
    const nativeNow = (await vb.list()).find((n) => n.id === native.id);
    rec(nativeNow?.content === "commons-only note" && nativeNow.path === "frontrange/sfr/local-note", "native destination note untouched");

    // 7) folder visibility: the destination note set carries the whole tree
    console.log("— 7) collaborator folder tree");
    bNotes = await vb.list();
    const tree = folderTreeOf(bNotes, "frontrange");
    for (const dir of ["frontrange/sfr", "frontrange/sfr/projects", "frontrange/sfr/projects/watershed"]) {
      rec(tree.has(dir), `sidebar derives folder "${dir}"`);
    }
  } finally {
    console.log("— teardown");
    await removeScratchVault(a.name);
    await removeScratchVault(b.name);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-folder-sync crashed:", e);
  process.exit(1);
});
