/**
 * scripts/vault-hygiene — schema fixes + dry-run-first data migrations, driven
 * against an in-memory fake vault (and a fake Prism trash route). Proves: a dry
 * run sends no write; --apply needs --backup-confirmed; writes are
 * compare-and-set (`if_updated_at`, never `force`) with an undo log that undo.ts
 * replays; production URLs need --production; tokens never reach the output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardTarget, UsageError, type Ctx, type UndoRecord, type VaultNote, type VaultTag } from "../../../scripts/vault-hygiene/lib";
import * as schema from "../../../scripts/vault-hygiene/apply-schema-fixes";
import * as emptyLists from "../../../scripts/vault-hygiene/migrate-empty-lists";
import * as folderLinks from "../../../scripts/vault-hygiene/migrate-project-folder-links";
import * as dups from "../../../scripts/vault-hygiene/trash-duplicates";
import * as untagged from "../../../scripts/vault-hygiene/report-untagged";
import * as undo from "../../../scripts/vault-hygiene/undo";

const READ = "read-tok-SECRET";
const ADMIN = "admin-tok-SECRET";
const OWNER = "owner-tok-SECRET";
const VAULT = ["--vault-url", "http://vault.test:7777"];

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: any;
}

class FakeVault {
  notes = new Map<string, VaultNote>();
  tags: VaultTag[] = [];
  calls: Call[] = [];
  clock = 1;
  /** Called before a PATCH is judged — lets a test edit the note "concurrently". */
  beforePatch?: (id: string) => void;

  add(n: Partial<VaultNote> & { id: string }): VaultNote {
    const note: VaultNote = { tags: [], metadata: {}, content: "", path: n.id, ...n, updatedAt: n.updatedAt ?? this.stamp() };
    this.notes.set(note.id, note);
    return note;
  }
  stamp(): string {
    return new Date(Date.UTC(2026, 9, 1, 0, 0, this.clock++)).toISOString();
  }
  find(idOrPath: string): VaultNote | undefined {
    return this.notes.get(idOrPath) ?? [...this.notes.values()].find((n) => n.path === idOrPath);
  }
  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization"), body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const api = "/vault/default/api";
    if (url.pathname === `${api}/tags` && method === "GET") return json(this.tags);
    if (url.pathname.startsWith(`${api}/tags/`) && method === "PUT") {
      const name = decodeURIComponent(url.pathname.slice(`${api}/tags/`.length));
      const t = this.tags.find((x) => x.name === name)!;
      t.fields = { ...(t.fields ?? {}), ...body.fields }; // merges per field, replacing a field's definition
      t.description = body.description;
      return json({ ok: true });
    }
    if (url.pathname === `${api}/notes` && method === "GET") {
      const tags = url.searchParams.getAll("tag");
      const prefix = url.searchParams.get("path_prefix");
      const keys = url.searchParams.get("include_metadata")?.split(",");
      const withContent = url.searchParams.get("include_content") === "true";
      const rows = [...this.notes.values()]
        .filter((n) => tags.every((t) => (n.tags ?? []).includes(t)) && (!prefix || (n.path ?? "").startsWith(prefix)))
        .map((n) => {
          const r: VaultNote = { ...n, metadata: keys ? Object.fromEntries(Object.entries(n.metadata ?? {}).filter(([k]) => keys.includes(k))) : { ...n.metadata } };
          if (!withContent) delete r.content;
          return r;
        });
      return json(rows);
    }
    if (url.pathname.startsWith(`${api}/notes/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${api}/notes/`.length));
      const note = this.find(id);
      if (!note) return json({ error: "not_found" }, 404);
      if (method === "GET") return json(structuredClone(note));
      if (method === "PATCH") {
        assert.equal(body.force, undefined, "a migration must never send force");
        assert.ok(body.if_updated_at, "every write carries if_updated_at");
        this.beforePatch?.(note.id);
        if (body.if_updated_at !== note.updatedAt) return json({ error: "conflict" }, 409);
        if (body.content !== undefined) note.content = body.content;
        for (const [k, v] of Object.entries(body.metadata ?? {})) {
          if (v === null) delete note.metadata![k];
          else note.metadata![k] = v;
        }
        note.updatedAt = this.stamp();
        return json(structuredClone(note));
      }
    }
    // The Prism Server's trash + restore routes.
    const trash = /^\/api\/notes\/([^/]+)\/trash$/.exec(url.pathname);
    if (trash && method === "POST") {
      const note = this.find(decodeURIComponent(trash[1]!))!;
      if (body?.if_updated_at !== note.updatedAt) return json({ error: "conflict" }, 409);
      note.tags = [...(note.tags ?? []), "prism-trashed"];
      note.metadata!.prism_trashed_at = "2026-10-08T00:00:00Z";
      note.updatedAt = this.stamp();
      return json({ ok: true });
    }
    const restore = /^\/api\/trash\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && method === "POST") {
      const note = this.find(decodeURIComponent(restore[1]!))!;
      note.tags = (note.tags ?? []).filter((t) => t !== "prism-trashed");
      delete note.metadata!.prism_trashed_at;
      return json({ ok: true });
    }
    return json({ error: "unexpected route" }, 500);
  }) as typeof fetch;
}

function ctxFor(v: FakeVault, env: Record<string, string> = {}): Ctx & { lines: string[]; undo: string[] } {
  const lines: string[] = [];
  const undoLines: string[] = [];
  return {
    fetch: v.fetch,
    env: { PARACHUTE_TOKEN: READ, ...env },
    log: (l) => lines.push(l),
    sleep: async () => {},
    appendUndo: (_p, l) => undoLines.push(l),
    now: () => new Date("2026-10-08T12:00:00Z"),
    lines,
    undo: undoLines,
  };
}

const out = (c: { lines: string[] }) => c.lines.join("\n");
const noSecrets = (c: { lines: string[] }) => {
  for (const s of [READ, ADMIN, OWNER]) assert.ok(!out(c).includes(s), `output leaked ${s}`);
};

// ------------------------------------------------------------------ guards

test("production URLs (:1940, the public host) need --production; credentials in a URL are refused", () => {
  assert.throws(() => guardTarget("http://127.0.0.1:1940", false), UsageError);
  assert.throws(() => guardTarget("https://agent.omniharmonic.com", false), UsageError);
  assert.equal(guardTarget("http://127.0.0.1:1940", true).port, "1940");
  assert.throws(() => guardTarget("http://u:p@vault.test:7777", true), UsageError);
  assert.throws(() => guardTarget(undefined, false), /required/);
});

test("every script refuses a production vault URL without --production (dry runs too)", async () => {
  const v = new FakeVault();
  for (const m of [schema.main, emptyLists.main, folderLinks.main, dups.main, untagged.main]) {
    await assert.rejects(m(["--vault-url", "http://127.0.0.1:1940"], ctxFor(v)), /PRODUCTION/);
  }
  assert.equal(v.calls.length, 0);
});

// ------------------------------------------------------------------ schema

function liveSchemas(): VaultTag[] {
  // The live vault as the canonical (pre-fix) definitions describe it.
  const fixes = schema.loadFixes();
  const tags = new Map<string, VaultTag>();
  for (const c of fixes) {
    const t = tags.get(c.tag) ?? { name: c.tag, description: `#${c.tag}`, fields: {} };
    if (c.from) t.fields![c.field] = { ...c.from };
    tags.set(c.tag, t);
  }
  tags.get("task")!.fields!.priority = { type: "string", indexed: true, enum: ["medium", "high", "critical", "low"], default: "medium" };
  return [...tags.values()];
}

test("schema: the dry run prints the diff against the live schema and writes nothing", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  const c = ctxFor(v);
  assert.equal(await schema.main(VAULT, c), 0);
  assert.equal(v.writes().length, 0);
  assert.match(out(c), /message-thread\.participants: type string → array/);
  assert.match(out(c), /message-thread\.lastMessageAt: type string → integer/);
  assert.match(out(c), /task\.status: enum \+\[pending, waiting, completed, archived\]/);
  assert.match(out(c), /project\.role: enum removed/);
  assert.doesNotMatch(out(c), /task\.owner/, "optional additions only with --include-optional");
  noSecrets(c);
});

test("schema: --apply needs --backup-confirmed and an admin token", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  await assert.rejects(schema.main([...VAULT, "--apply"], ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN })), /backup-confirmed/);
  await assert.rejects(schema.main([...VAULT, "--apply", "--backup-confirmed"], ctxFor(v)), /PARACHUTE_ADMIN_TOKEN/);
  assert.equal(v.writes().length, 0);
});

test("schema: apply PUTs with the admin token, keeps other fields + indexes, skips drift, verifies, and is idempotent", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  v.tags.find((t) => t.name === "spec")!.fields!.version = { type: "integer" }; // drift: someone changed it
  const c = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  assert.equal(await schema.main([...VAULT, "--apply", "--backup-confirmed"], c), 0);
  const puts = v.writes();
  assert.ok(puts.length > 0 && puts.every((p) => p.method === "PUT" && p.auth === `Bearer ${ADMIN}`));
  assert.ok(!puts.some((p) => p.path.endsWith("/tags/spec")), "a drifted field is left alone");
  const task = puts.find((p) => p.path.endsWith("/tags/task"))!.body;
  assert.deepEqual(task.fields.priority.indexed, true, "the existing index survives");
  assert.ok(task.fields.status.enum.includes("pending"));
  assert.equal(v.tags.find((t) => t.name === "message-thread")!.fields!.participants!.type, "array");
  assert.match(out(c), /SKIP \(drift\)/);
  assert.match(out(c), /verify: all \d+ change\(s\) live/);
  noSecrets(c);

  const again = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  const before = v.writes().length;
  await schema.main([...VAULT, "--apply", "--backup-confirmed"], again);
  assert.equal(v.writes().length, before, "a second run writes nothing");
  assert.match(out(again), /summary: 0 to apply/);
});

test("schema: --reverse plans every applied change back to its old definition", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  await schema.main([...VAULT, "--apply", "--backup-confirmed"], ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN }));
  const c = ctxFor(v);
  await schema.main([...VAULT, "--reverse"], c);
  assert.match(out(c), /message-thread\.participants: type array → string/);
});

test("schema: tag-schemas.json (what seeds new vaults) already carries every core fix and none of the optional ones", () => {
  const canonical = JSON.parse(readFileSync(new URL("../../../packages/core/src/lib/schemas/tag-schemas.json", import.meta.url), "utf8")).tags;
  for (const c of schema.loadFixes()) {
    const def = canonical[c.tag]?.fields?.[c.field];
    if (c.optional) assert.equal(def, undefined, `${c.tag}.${c.field} is optional and must not be seeded`);
    else assert.equal(schema.essentials(def), schema.essentials(c.to), `${c.tag}.${c.field}`);
  }
});

// ------------------------------------------------------------------ (a) "" placeholders

function seedEmpty(v: FakeVault) {
  v.add({ id: "p1", path: "vault/people/ada", tags: ["person"], metadata: { organizations: "", aliases: "", projects: ["[[vault/projects/x/PROJECT]]"], confidence: "" } });
  v.add({ id: "p2", path: "vault/people/bo", tags: ["person"], metadata: { organizations: ["Acme"], aliases: [] } });
  v.add({ id: "o1", path: "vault/organizations/acme", tags: ["organization"], metadata: { people: "", projects: "" } });
  v.add({ id: "e1", path: "vault/messages/email/x", tags: ["email", "person"], metadata: { aliases: "" } });
}

test("(a) dry run counts \"\" placeholders without reading bodies and writes nothing", async () => {
  const v = new FakeVault();
  seedEmpty(v);
  const c = ctxFor(v);
  assert.equal(await emptyLists.main(VAULT, c), 0);
  assert.equal(v.writes().length, 0);
  assert.ok(v.calls.every((x) => !x.path.match(/\/notes\/./)), "no per-note reads in a dry run");
  assert.match(out(c), /2 note\(s\) hold/);
  assert.match(out(c), /person\.organizations: 1/);
  assert.doesNotMatch(out(c), /e1/, "ingest-owned notes are never touched");
});

test("(a) apply: fresh read, CAS PATCH with null (never force), undo log; undo.ts restores it", async () => {
  const v = new FakeVault();
  seedEmpty(v);
  await assert.rejects(emptyLists.main([...VAULT, "--apply"], ctxFor(v)), /backup-confirmed/);
  const c = ctxFor(v);
  assert.equal(await emptyLists.main([...VAULT, "--apply", "--backup-confirmed"], c), 0);
  const patches = v.writes();
  assert.equal(patches.length, 2);
  for (const p of patches) assert.ok(p.body.if_updated_at && p.body.force === undefined);
  assert.deepEqual(patches.find((p) => p.path.endsWith("/p1"))!.body.metadata, { organizations: null, aliases: null });
  assert.equal(v.notes.get("p1")!.metadata!.confidence, "", "scalars only with --include-scalars");
  assert.ok(!("organizations" in v.notes.get("p1")!.metadata!));
  const recs = c.undo.map((l) => JSON.parse(l) as UndoRecord);
  assert.equal(recs.length, 2);
  assert.deepEqual((recs.find((r) => r.id === "p1") as any).before.metadata, { organizations: "", aliases: "" });

  const u = ctxFor(v);
  assert.equal(await undo.main([...VAULT, "--apply"], u, recs), 0);
  assert.equal(v.notes.get("p1")!.metadata!.organizations, "");
  assert.equal(v.notes.get("o1")!.metadata!.people, "");
});

test("(a) a note edited between the read and the write is a conflict: no force, no retry", async () => {
  const v = new FakeVault();
  seedEmpty(v);
  v.beforePatch = (id) => {
    if (id === "p1") v.notes.get("p1")!.updatedAt = v.stamp();
  };
  const c = ctxFor(v);
  await emptyLists.main([...VAULT, "--apply", "--backup-confirmed", "--mode", "empty-list"], c);
  assert.equal(v.writes().filter((w) => w.path.endsWith("/p1")).length, 1);
  assert.equal(v.notes.get("p1")!.metadata!.organizations, "", "the conflicting note is untouched");
  assert.deepEqual(v.notes.get("o1")!.metadata!.people, [], "--mode empty-list writes []");
  assert.match(out(c), /1 conflict/);
  assert.equal(c.undo.length, 1, "only real writes are logged");
});

test("undo leaves a note alone when it was edited after the migration", async () => {
  const v = new FakeVault();
  seedEmpty(v);
  const c = ctxFor(v);
  await emptyLists.main([...VAULT, "--apply", "--backup-confirmed"], c);
  v.notes.get("p1")!.updatedAt = v.stamp(); // edited since
  const u = ctxFor(v);
  const before = v.writes().length;
  await undo.main([...VAULT, "--apply"], u, c.undo.map((l) => JSON.parse(l)));
  assert.equal(v.writes().length, before + 1, "only o1 is restored");
  assert.match(out(u), /edited since/);
});

// ------------------------------------------------------------------ (b) folder links

function seedProjects(v: FakeVault) {
  v.add({ id: "pr1", path: "vault/projects/alpha/PROJECT", tags: ["project"] });
  v.add({ id: "pr2", path: "vault/projects/beta/notes", tags: ["project"] }); // the only project note under beta/
  v.add({ id: "pr3", path: "vault/projects/gamma/a", tags: ["project"] });
  v.add({ id: "pr4", path: "vault/projects/gamma/b", tags: ["project"] }); // two → ambiguous
  v.add({ id: "pr5", path: "vault/projects/delta", tags: ["project"] }); // the folder path is a note: not broken
}

test("(b) resolver: exactly one candidate repoints; zero/several are listed; an existing note is left", () => {
  const v = new FakeVault();
  seedProjects(v);
  const r = folderLinks.buildResolver([...v.notes.values()]);
  assert.deepEqual(r("alpha"), { kind: "target", path: "vault/projects/alpha/PROJECT" });
  assert.deepEqual(r("Alpha"), { kind: "target", path: "vault/projects/alpha/PROJECT" });
  assert.deepEqual(r("beta"), { kind: "target", path: "vault/projects/beta/notes" });
  assert.equal(r("gamma").kind, "unresolved");
  assert.equal(r("nope").kind, "unresolved");
  assert.deepEqual(r("delta"), { kind: "exists" });
  const hits: folderLinks.Hit[] = [];
  const text = "See [[vault/projects/alpha|Alpha]], [[vault/projects/alpha#Goals]], [[vault/projects/gamma]], [[vault/projects/alpha/PROJECT]] and [[ unclosed";
  assert.equal(
    folderLinks.rewriteText(text, r, hits),
    "See [[vault/projects/alpha/PROJECT|Alpha]], [[vault/projects/alpha/PROJECT#Goals]], [[vault/projects/gamma]], [[vault/projects/alpha/PROJECT]] and [[ unclosed",
  );
  assert.equal(hits.length, 3);
});

test("(b) dry run prints no bodies and writes nothing; apply rewrites content + metadata with CAS and an undo log", async () => {
  const v = new FakeVault();
  seedProjects(v);
  const BODY = "Private meeting text about [[vault/projects/alpha]] and [[vault/projects/gamma]].";
  v.add({ id: "m1", path: "vault/meetings/2026-10-01/sync", tags: ["meeting"], content: BODY, metadata: { projects: ["[[vault/projects/beta]]", "[[vault/projects/alpha/PROJECT]]"] } });
  v.add({ id: "t1", path: "vault/messages/telegram/x", tags: ["message-thread", "meeting"], content: "[[vault/projects/alpha]]" });
  const dry = ctxFor(v);
  assert.equal(await folderLinks.main(VAULT, dry), 0);
  assert.equal(v.writes().length, 0);
  assert.ok(!out(dry).includes("Private meeting text"), "never prints a body");
  assert.match(out(dry), /vault\/projects\/gamma: 1 link\(s\) — 2 project notes/);

  const c = ctxFor(v);
  assert.equal(await folderLinks.main([...VAULT, "--apply", "--backup-confirmed"], c), 0);
  const w = v.writes();
  assert.equal(w.length, 1, "the ingest-owned thread is never touched");
  assert.ok(w[0]!.body.if_updated_at && w[0]!.body.force === undefined);
  assert.equal(v.notes.get("m1")!.content, "Private meeting text about [[vault/projects/alpha/PROJECT]] and [[vault/projects/gamma]].");
  assert.deepEqual(v.notes.get("m1")!.metadata!.projects, ["[[vault/projects/beta/notes]]", "[[vault/projects/alpha/PROJECT]]"]);
  const rec = JSON.parse(c.undo[0]!);
  assert.equal(rec.before.content, BODY);
  await undo.main([...VAULT, "--apply"], ctxFor(v), [rec]);
  assert.equal(v.notes.get("m1")!.content, BODY);
  assert.deepEqual(v.notes.get("m1")!.metadata!.projects, ["[[vault/projects/beta]]", "[[vault/projects/alpha/PROJECT]]"]);
});

// ------------------------------------------------------------------ (c) duplicates

function seedDups(v: FakeVault) {
  v.add({ id: "canon", path: "vault/_inbox/transcripts/fireflies/a", tags: ["transcript"], metadata: { source_id: "FF1" } });
  v.add({ id: "d1", path: "vault/_inbox/transcripts/fireflies/a-copy", tags: ["transcript", "duplicate"], metadata: { source_id: "FF1" } });
  v.add({ id: "d2", path: "vault/notes/b-copy", tags: ["duplicate"], metadata: { duplicate_of: "[[vault/notes/b]]" } });
  v.add({ id: "b", path: "vault/notes/b", tags: [] });
  v.add({ id: "d3", path: "vault/notes/c-copy", tags: ["duplicate"], metadata: {} }); // no twin: review
  v.add({ id: "x1", path: "vault/_inbox/transcripts/fireflies/z1", tags: ["transcript"], metadata: { source_id: "FF9" } });
  v.add({ id: "x2", path: "vault/_inbox/transcripts/fireflies/z2", tags: ["transcript"], metadata: { source_id: "FF9" } });
  v.add({ id: "d4", path: "vault/_inbox/transcripts/fireflies/z3", tags: ["transcript", "duplicate"], metadata: { source_id: "FF9" } }); // two twins: review
  v.add({ id: "d5", path: "vault/notes/parent", tags: ["duplicate"], metadata: { canonical: "b" } });
  v.add({ id: "d5c", path: "vault/notes/parent/child", tags: [] }); // d5 has a sub-page
}

test("(c) only duplicates with an identified twin are planned; the rest are listed; dry run writes nothing", async () => {
  const v = new FakeVault();
  seedDups(v);
  const c = ctxFor(v);
  assert.equal(await dups.main(VAULT, c), 0);
  assert.equal(v.writes().length, 0);
  assert.match(out(c), /trash d1 .*twin canon .*same recording id/);
  assert.match(out(c), /trash d2 .*twin b .*metadata\.duplicate_of/);
  assert.match(out(c), /REVIEW d3/);
  assert.match(out(c), /REVIEW d4 .*2 notes share/);
});

test("(c) apply trashes through Prism with if_updated_at, skips a note with sub-pages, logs undo; undo restores", async () => {
  const v = new FakeVault();
  seedDups(v);
  await assert.rejects(dups.main([...VAULT, "--apply", "--backup-confirmed", "--prism-url", "http://prism.test:8787"], ctxFor(v)), /PRISM_OWNER_TOKEN/);
  const c = ctxFor(v, { PRISM_OWNER_TOKEN: OWNER });
  await dups.main([...VAULT, "--apply", "--backup-confirmed", "--prism-url", "http://prism.test:8787"], c);
  const posts = v.writes();
  assert.deepEqual(posts.map((p) => p.path).sort(), ["/api/notes/d1/trash", "/api/notes/d2/trash"]);
  assert.ok(posts.every((p) => p.auth === `Bearer ${OWNER}` && p.body.if_updated_at));
  assert.match(out(c), /skip d5 .*sub-page/);
  assert.ok(v.notes.get("d1")!.tags!.includes("prism-trashed"));
  assert.ok(!v.notes.get("d3")!.tags!.includes("prism-trashed"));
  noSecrets(c);
  const recs = c.undo.map((l) => JSON.parse(l));
  await undo.main([...VAULT, "--apply", "--prism-url", "http://prism.test:8787"], ctxFor(v, { PRISM_OWNER_TOKEN: OWNER }), recs);
  assert.ok(!v.notes.get("d1")!.tags!.includes("prism-trashed"));
});

// ------------------------------------------------------------------ (d) untagged

test("(d) the untagged report groups by folder with a suggestion and never writes", async () => {
  const v = new FakeVault();
  v.add({ id: "u1", path: "vault/projects/cri/outputs/a", tags: [] });
  v.add({ id: "u2", path: "vault/projects/cri/outputs/b", tags: [] });
  v.add({ id: "u3", path: "vault/projects/dacc/research/c", tags: [] });
  v.add({ id: "u4", path: "_templates/person", tags: [] });
  v.add({ id: "t", path: "vault/projects/cri/PROJECT", tags: ["project"] });
  const c = ctxFor(v);
  assert.equal(await untagged.main(VAULT, c), 0);
  assert.equal(v.writes().length, 0);
  assert.match(out(c), /2 {2}vault\/projects\/cri .*suggest: cri \+ document/);
  assert.match(out(c), /vault\/projects\/dacc .*suggest: dacc \+ research/);
  assert.match(out(c), /_templates .*leave untagged/);
  assert.match(out(c), /people\/link/);
  await assert.rejects(untagged.main([...VAULT, "--apply"], c), /never writes/);
});
