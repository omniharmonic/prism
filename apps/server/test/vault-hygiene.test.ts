/**
 * scripts/vault-hygiene — schema fixes + dry-run-first data migrations, driven
 * against an in-memory fake vault (and a fake Prism trash route). Proves: a dry
 * run sends no write; --apply needs --backup-confirmed; writes are
 * compare-and-set (`if_updated_at`, never `force`) with an undo log that undo.ts
 * replays; production URLs need --production; tokens never reach the output.
 */
// Timed in CPU time of this thread (./probe), never on the wall clock: the figure is the work, not the machine's load.
import { threadCpuMs } from "./probe";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { guardTarget, UsageError, type Ctx, type UndoRecord, type VaultNote, type VaultTag } from "../../../scripts/vault-hygiene/lib";
import * as schema from "../../../scripts/vault-hygiene/apply-schema-fixes";
import * as emptyLists from "../../../scripts/vault-hygiene/migrate-empty-lists";
import * as fieldShapes from "../../../scripts/vault-hygiene/migrate-field-shapes";
import { LIST_FIELDS_BY_TAG } from "../src/vault-shapes";
import * as folderLinks from "../../../scripts/vault-hygiene/migrate-project-folder-links";
import * as dups from "../../../scripts/vault-hygiene/trash-duplicates";
import * as untagged from "../../../scripts/vault-hygiene/report-untagged";
import * as projectPages from "../../../scripts/vault-hygiene/project-pages";
import * as undo from "../../../scripts/vault-hygiene/undo";
import * as subpageLinks from "../../../scripts/vault-hygiene/backfill-subpage-links";
import { extractChildPageIds } from "@prism/core/mentions";

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
  /** The vault's link table; a note read with `include_links` carries the rows it is an end of. */
  links: Array<{ sourceId: string; targetId: string; relationship: string }> = [];
  linksOf(id: string) {
    return this.links.filter((l) => l.sourceId === id || l.targetId === id).map((l) => ({ ...l }));
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
      // Like vault 0.7.9: every field in the body must agree in type with every OTHER tag that
      // declares it, else 422 and nothing is written (core collectCrossTagFieldViolations).
      const violations = Object.entries(body.fields as Record<string, { type?: string }>).flatMap(([field, def]) =>
        this.tags.filter((o) => o.name !== name && o.fields?.[field] && o.fields[field]!.type !== def.type).map((o) => ({ field, reason: "type_conflict", other_tag: o.name })),
      );
      if (violations.length) return json({ error: "tag_field_conflict", error_type: "tag_field_conflict", tag: name, violations }, 422);
      // merges per field, replacing a field's definition — unless replace_fields, where absent fields are dropped
      t.fields = body.replace_fields ? { ...body.fields } : { ...(t.fields ?? {}), ...body.fields };
      t.description = body.description;
      return json({ ok: true });
    }
    if (url.pathname === `${api}/notes` && method === "POST") {
      assert.equal(body.if_exists, "ignore");
      const exists = this.find(body.path);
      if (exists) return json({ ...exists, existed: true });
      const note = this.add({ id: `created-${this.clock}`, path: body.path, content: body.content, tags: body.tags, metadata: body.metadata });
      return json({ ...note, existed: false });
    }
    if (url.pathname === `${api}/notes` && method === "GET") {
      const tags = url.searchParams.getAll("tag");
      const prefix = url.searchParams.get("path_prefix");
      const keys = url.searchParams.get("include_metadata")?.split(",");
      const withContent = url.searchParams.get("include_content") === "true";
      const withLinks = url.searchParams.get("include_links") === "true";
      const rows = [...this.notes.values()]
        .filter((n) => tags.every((t) => (n.tags ?? []).includes(t)) && (!prefix || (n.path ?? "").startsWith(prefix)))
        .map((n) => {
          const r: VaultNote = { ...n, metadata: keys ? Object.fromEntries(Object.entries(n.metadata ?? {}).filter(([k]) => keys.includes(k))) : { ...n.metadata } };
          if (!withContent) delete r.content;
          if (withLinks) r.links = this.linksOf(n.id);
          else delete r.links;
          return r;
        });
      return json(rows);
    }
    if (url.pathname.startsWith(`${api}/notes/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${api}/notes/`.length));
      const note = this.find(id);
      if (!note) return json({ error: "not_found" }, 404);
      if (method === "GET") {
        const copy = structuredClone(note);
        if (url.searchParams.get("include_content") === "false") delete copy.content;
        if (url.searchParams.get("include_links") === "true") copy.links = this.linksOf(note.id);
        else delete copy.links;
        return json(copy);
      }
      if (method === "PATCH") {
        assert.equal(body.force, undefined, "a migration must never send force");
        assert.ok(body.if_updated_at, "every write carries if_updated_at");
        this.beforePatch?.(note.id);
        if (body.if_updated_at !== note.updatedAt) return json({ error: "conflict" }, 409);
        // Typed links, like the vault: targets resolve by id or path; add is INSERT OR IGNORE.
        for (const l of body.links?.add ?? []) {
          const t = this.find(l.target);
          if (t && !this.links.some((x) => x.sourceId === note.id && x.targetId === t.id && x.relationship === l.relationship)) this.links.push({ sourceId: note.id, targetId: t.id, relationship: l.relationship });
        }
        for (const l of body.links?.remove ?? []) {
          const t = this.find(l.target);
          this.links = this.links.filter((x) => !(x.sourceId === note.id && x.targetId === t?.id && x.relationship === l.relationship));
        }
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
      note.updatedAt = this.stamp();
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
  for (const m of [schema.main, emptyLists.main, fieldShapes.main, folderLinks.main, dups.main, untagged.main, subpageLinks.main]) {
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

test("schema: a type change of a field several tags share is dropped everywhere, then re-declared (the vault refuses it tag by tag)", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  const c = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  assert.equal(await schema.main([...VAULT, "--apply", "--backup-confirmed"], c), 0, c.lines.join("\n"));
  for (const tag of ["person", "project", "organization", "concept"]) {
    assert.equal(v.tags.find((t) => t.name === tag)!.fields!.confidence!.type, "string", tag);
  }
  const drops = v.writes().filter((w) => w.body.replace_fields === true);
  assert.deepEqual(drops.map((w) => w.path.split("/").pop()).sort(), ["concept", "organization", "person", "project"]);
  assert.ok(drops.every((w) => !("confidence" in w.body.fields)));
  assert.ok(c.lines.some((l) => /verify: all \d+ change\(s\) live/.test(l)));
});

test("schema: a run that stopped after dropping a shared field finishes on the next run", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  delete v.tags.find((t) => t.name === "person")!.fields!.confidence; // dropped, then the run died
  const plan = schema.planChanges(schema.loadFixes(), v.tags, { includeOptional: true });
  assert.equal(plan.find((p) => p.change.id === "person-confidence")!.verdict, "pending");
  assert.equal(await schema.main([...VAULT, "--apply", "--backup-confirmed"], ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN })), 0);
  assert.equal(v.tags.find((t) => t.name === "person")!.fields!.confidence!.type, "string");
});

test("schema: a shared field another tag outside the plan declares differently stops the run before any write", async () => {
  const v = new FakeVault();
  v.tags = [...liveSchemas(), { name: "outsider", description: "x", fields: { confidence: { type: "number" } } }];
  const c = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  assert.equal(await schema.main([...VAULT, "--apply", "--backup-confirmed"], c), 1);
  assert.equal(v.writes().length, 0);
  assert.ok(c.lines.some((l) => l.includes("BLOCKED confidence") && l.includes("#outsider")));
});

test("schema: a field whose live definition has no default gets the new options and still no default", async () => {
  const v = new FakeVault();
  v.tags = liveSchemas();
  for (const tag of ["task", "organization", "writing"]) delete v.tags.find((t) => t.name === tag)!.fields!.status!.default; // an older vault: never stored
  const dry = ctxFor(v);
  await schema.main(VAULT, dry);
  assert.ok(dry.lines.some((l) => l.startsWith("  task.status:") && l.includes("pending") && l.includes("no default kept")), dry.lines.join("\n"));
  assert.ok(!dry.lines.some((l) => /status: SKIP \(drift\)/.test(l) && /task|organization|writing/.test(l)));
  const c = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  assert.equal(await schema.main([...VAULT, "--apply", "--backup-confirmed"], c), 0, c.lines.join("\n"));
  const status = v.tags.find((t) => t.name === "task")!.fields!.status!;
  assert.ok(status.enum!.includes("waiting") && status.enum!.includes("archived"));
  assert.equal(status.default, undefined, "no default was added");
  assert.ok(v.tags.find((t) => t.name === "organization")!.fields!.status!.enum!.includes("merged_into_canonical"));
  const again = ctxFor(v, { PARACHUTE_ADMIN_TOKEN: ADMIN });
  await schema.main([...VAULT, "--apply", "--backup-confirmed"], again);
  assert.ok(again.lines.some((l) => l.includes("task.status: already applied")), "idempotent");
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

// ------------------------------------------------------------------ field shapes (f)

test("field-shapes: the list table is the server's (minus the ingest-owned message-thread)", () => {
  const { "message-thread": _ingest, ...rest } = LIST_FIELDS_BY_TAG as Record<string, readonly string[]>;
  assert.deepEqual(Object.fromEntries(Object.entries(fieldShapes.LIST_FIELDS).map(([k, v]) => [k, [...v].sort()])), Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, [...v].sort()])));
});

test("field-shapes: every correction says exactly what the stored value said; anything else is left alone", () => {
  const fix = (field: string, v: unknown) => fieldShapes.listFix(field, v);
  assert.deepEqual(fix("projects", ""), { rule: "blank-removed", to: null });
  assert.deepEqual(fix("projects", "   "), { rule: "blank-removed", to: null });
  assert.deepEqual(fix("projects", "regen-commons"), { rule: "text-to-list", to: ["regen-commons"] });
  assert.deepEqual(fix("projects", "[[vault/projects/a/PROJECT]]"), { rule: "text-to-list", to: ["[[vault/projects/a/PROJECT]]"] });
  assert.deepEqual(fix("projects", "opencivics, regen-commons;trustgraph"), { rule: "split-to-list", to: ["opencivics", "regen-commons", "trustgraph"] });
  assert.deepEqual(fix("projects", "[[a/b|One, two]], [[c]]"), { rule: "split-to-list", to: ["[[a/b|One, two]]", "[[c]]"] }, "a comma inside a link is not a separator");
  assert.deepEqual(fix("projects", "Sprint 6 (10/6 - 10/20), Product Milestones"), { rule: "text-to-list", to: ["Sprint 6 (10/6 - 10/20), Product Milestones"] }, "free text is never split");
  assert.deepEqual(fix("attendees", "Doe, Jane"), { rule: "text-to-list", to: ["Doe, Jane"] }, "a name with a comma stays one value");
  assert.deepEqual(fix("keywords", "commons, Local Food; governance"), { rule: "split-to-list", to: ["commons", "Local Food", "governance"] });
  assert.deepEqual(fix("attendees", ["a@b.c", "", " "]), { rule: "blank-items-dropped", to: ["a@b.c"] });
  assert.deepEqual(fix("attendees", ["", ""]), { rule: "blank-items-dropped", to: null });
  for (const fine of [["x"], [], 7, { a: 1 }, true, null]) assert.equal(fix("projects", fine), undefined);
  assert.deepEqual(fieldShapes.splitOutsideLinks("a,,b ; "), ["a", "b"]);
  const t0 = threadCpuMs(); // CPU time of this thread (./probe), not the wall clock
  fieldShapes.splitOutsideLinks("[[".repeat(200_000) + ",".repeat(200_000));
  assert.ok(threadCpuMs() - t0 < 1500, "linear on hostile input");
});

function seedShapes(v: FakeVault): void {
  v.add({ id: "m1", path: "vault/meetings/2026-01/one", tags: ["meeting", "transcript"], metadata: { projects: "opencivics, regen-commons", attendees: "", source: "", recording_id: 12345, title: "keep me" } });
  v.add({ id: "m2", path: "vault/meetings/2026-01/two", tags: ["meeting"], metadata: { projects: ["[[vault/projects/a/PROJECT]]"], attendees: ["a@b.c"], source: "fathom", recording_id: "777" } });
  v.add({ id: "s1", path: "vault/specs/one", tags: ["spec"], metadata: { version: 1.2, project: "x" } });
  v.add({ id: "o1", path: "vault/organizations/one", tags: ["organization"], metadata: { status: "", people: ["[[vault/people/a]]"] } });
  v.add({ id: "tr1", path: "vault/meetings/2026-01/three", tags: ["transcript"], metadata: { duration_minutes: "", source: "fathom" } });
  v.add({ id: "pr1", path: "vault/projects/a/PROJECT", tags: ["project"], metadata: { keywords: "commons, food", confidence: 0.85 } });
  v.add({ id: "e1", path: "vault/messages/email/x", tags: ["email", "meeting"], metadata: { projects: "x", recording_id: 5 } });
  v.add({ id: "t1", path: "vault/meetings/trashed", tags: ["meeting", "prism-trashed"], metadata: { projects: "x" } });
}

test("field-shapes: the dry run counts per field and rule, prints no value and writes nothing", async () => {
  const v = new FakeVault();
  seedShapes(v);
  const c = ctxFor(v);
  assert.equal(await fieldShapes.main(VAULT, c), 0);
  assert.equal(v.writes().length, 0);
  assert.match(out(c), /DRY RUN — 5 note\(s\)/);
  assert.match(out(c), /organization\.status: blank-removed: 1/);
  assert.match(out(c), /transcript\.duration_minutes: blank-removed: 1/);
  assert.match(out(c), /meeting\.projects: split-to-list: 1/);
  assert.match(out(c), /meeting\.recording_id: number-to-text: 1/);
  assert.match(out(c), /spec\.version: number-to-text: 1/);
  assert.match(out(c), /project\.keywords: split-to-list: 1/);
  assert.ok(!out(c).includes("opencivics") && !out(c).includes("12345") && !out(c).includes("keep me"), "values never reach the output");
});

test("field-shapes: apply is compare-and-set, touches only the corrected keys, skips ingest-owned and trashed notes, and undo restores every value", async () => {
  const v = new FakeVault();
  seedShapes(v);
  const c = ctxFor(v);
  await assert.rejects(fieldShapes.main([...VAULT, "--apply"], ctxFor(v)), /backup-confirmed/);
  assert.equal(await fieldShapes.main([...VAULT, "--apply", "--backup-confirmed"], c), 0);
  const patches = v.writes();
  assert.deepEqual(patches.map((p) => p.path.split("/").pop()).sort(), ["m1", "o1", "pr1", "s1", "tr1"]);
  for (const p of patches) assert.ok(p.body.if_updated_at && p.body.force === undefined && p.body.content === undefined);
  assert.deepEqual(patches.find((p) => p.path.endsWith("/m1"))!.body.metadata, { projects: ["opencivics", "regen-commons"], attendees: null, source: null, recording_id: "12345" });
  assert.deepEqual(v.notes.get("m1")!.metadata, { projects: ["opencivics", "regen-commons"], recording_id: "12345", title: "keep me" });
  assert.equal(v.notes.get("s1")!.metadata!.version, "1.2");
  assert.deepEqual(v.notes.get("pr1")!.metadata, { keywords: ["commons", "food"], confidence: 0.85 }, "a decimal confidence is not guessed into a label");
  assert.deepEqual(v.notes.get("e1")!.metadata, { projects: "x", recording_id: 5 }, "ingest-owned");
  assert.deepEqual(v.notes.get("t1")!.metadata, { projects: "x" }, "trashed");
  const again = ctxFor(v);
  await fieldShapes.main([...VAULT, "--apply", "--backup-confirmed"], again);
  assert.equal(v.writes().length, patches.length, "idempotent");

  const recs = c.undo.map((l) => JSON.parse(l) as UndoRecord);
  assert.deepEqual((recs.find((r) => r.id === "m1") as any).before.metadata, { projects: "opencivics, regen-commons", attendees: "", source: "", recording_id: 12345 });
  assert.equal(await undo.main([...VAULT, "--apply"], ctxFor(v), recs), 0);
  assert.deepEqual(v.notes.get("m1")!.metadata, { projects: "opencivics, regen-commons", attendees: "", source: "", recording_id: 12345, title: "keep me" });
  assert.equal(v.notes.get("s1")!.metadata!.version, 1.2);
});

test("field-shapes: a note edited between the listing and the write is re-judged on its fresh copy", async () => {
  const v = new FakeVault();
  seedShapes(v);
  v.beforePatch = (id) => {
    if (id === "s1") v.notes.get("s1")!.updatedAt = v.stamp();
  };
  const c = ctxFor(v);
  assert.equal(await fieldShapes.main([...VAULT, "--apply", "--backup-confirmed"], c), 0);
  assert.match(out(c), /1 conflict/);
  assert.equal(v.notes.get("s1")!.metadata!.version, 1.2, "the conflicting note is left for the next run");
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

// ------------------------------------------------------------------ (g) sub-page links

const row = (id: string) => `<div data-type="child-page" data-page-id="${id}"></div>`;
const BODY_SECRET = "PRIVATE-BODY-TEXT";

function seedSubpages(v: FakeVault) {
  v.add({ id: "parent", path: "vault/projects/atlas/PROJECT", tags: ["project"], content: `<p>${BODY_SECRET}</p>${row("kid1")}${row("kid2")}${row("gone")}${row("binned")}${row("parent")}` });
  v.add({ id: "kid1", path: "vault/projects/atlas/Plan" });
  v.add({ id: "kid2", path: "vault/projects/atlas/Notes" });
  v.add({ id: "binned", path: "vault/projects/atlas/Old", tags: ["prism-trashed"], metadata: { prism_trashed_at: "2026-10-01T00:00:00Z" } });
  v.add({ id: "done", path: "vault/notes/Linked already", content: `<p>x</p>${row("kid1")}` });
  v.links.push({ sourceId: "done", targetId: "kid1", relationship: "mentions" });
  // A link of another kind is not the sub-page link: `mentions` is still added.
  v.add({ id: "other", path: "vault/notes/Other kind", content: row("kid2") });
  v.links.push({ sourceId: "other", targetId: "kid2", relationship: "related" });
  v.add({ id: "plain", path: "vault/notes/No rows", content: "<p>data-type=\"child-page\" is only text here</p>" });
  v.add({ id: "mail", path: "vault/email/x", tags: ["email"], content: row("kid1") });
  v.add({ id: "trashedParent", path: "vault/notes/Trashed parent", tags: ["prism-trashed"], content: row("kid1") });
}

test("(g) childPageIds: a linear scan that reads rows exactly like the server's extractChildPageIds", () => {
  const cases = [
    `${row("a")}${row("b")}${row("a")}`,
    `<div data-page-id='q1' class="x" data-type='child-page'></div>`,
    `<div data-page-id='q1' class="x" data-type="child-page"></div>`,
    `<div data-type="child-page" data-page-id="bad id"></div>${row("ok_1-2")}`,
    `<div data-type="child-pages" data-page-id="no"></div><div xdata-type="child-page" data-page-id="no2"></div>`,
    `<p data-type="child-page" data-page-id="p"></p><span>data-type="child-page"</span>`,
    `<div data-type="child-page"></div><div data-type="child-page" data-page-id=""></div>`,
    `<div data-type="child-page" data-page-id="unterminated`,
    "",
    "<p>nothing</p>",
    Array.from({ length: 300 }, (_, i) => row(`n${i}`)).join("<p>x</p>"),
  ];
  for (const html of cases) assert.deepEqual(subpageLinks.childPageIds(html), extractChildPageIds(html), html.slice(0, 80));
  assert.deepEqual(subpageLinks.childPageIds(cases[0]), ["a", "b"]);
  assert.deepEqual(subpageLinks.childPageIds(`<div data-page-id='q1' class="x" data-type="child-page"></div>`), ["q1"]); // attribute order and quote style do not matter
  assert.deepEqual(subpageLinks.childPageIds(null), []);
  // Linear on a hostile body.
  const t0 = threadCpuMs();
  subpageLinks.childPageIds(`data-type="child-page"` + "<div ".repeat(200_000) + "<div data-page-id=".repeat(50_000));
  assert.ok(threadCpuMs() - t0 < 2000);
});

test("(g) planNote: links only live sub-pages that are not linked yet", () => {
  const live = new Set(["p", "a", "b"]);
  const note = { id: "p", content: `${row("a")}${row("b")}${row("zz")}${row("p")}`, links: [{ sourceId: "p", targetId: "a", relationship: "mentions" }, { sourceId: "b", targetId: "p", relationship: "mentions" }] };
  assert.deepEqual(subpageLinks.planNote(note, live), { add: ["b"], linked: 1, dangling: 2, rows: 4 });
  // A note read WITHOUT its links plans nothing (never assumes a link is missing).
  assert.deepEqual(subpageLinks.planNote({ id: "p", content: row("a") }, live).add, []);
  assert.deepEqual(subpageLinks.planNote({ id: "p", content: "<p>x</p>", links: [] }, live), { add: [], linked: 0, dangling: 0, rows: 0 });
});

test("(g) dry run: counts and ids/paths only — no write, no body, no token", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  const c = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--all"], c), 0);
  assert.equal(v.writes().length, 0);
  assert.match(out(c), /DRY RUN — scanned \d+ note\(s\); 3 hold sub-page rows \(7 row\(s\)\)/);
  assert.match(out(c), /1 row\(s\) already linked; 3 link\(s\) to add on 2 note\(s\); 3 row\(s\) name a missing or trashed page/);
  assert.match(out(c), /e\.g\. parent vault\/projects\/atlas\/PROJECT \(\+2\)/);
  assert.ok(!out(c).includes(BODY_SECRET) && !out(c).includes("child-page"));
  noSecrets(c);
  assert.equal(c.undo.length, 0);
});

test("(g) --apply needs --backup-confirmed; --limit must be positive", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  await assert.rejects(subpageLinks.main([...VAULT, "--apply"], ctxFor(v)), /backup-confirmed/);
  await assert.rejects(subpageLinks.main([...VAULT, "--limit", "0"], ctxFor(v)), /--limit/);
  await assert.rejects(subpageLinks.main([...VAULT, "--force"], ctxFor(v)), /unknown flag/);
  assert.equal(v.writes().length, 0);
});

test("(g) apply: one links-only CAS PATCH per parent (never force, no content, no metadata), undo log; undo.ts removes exactly those links", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  const before = structuredClone([...v.notes.values()].map((n) => ({ id: n.id, content: n.content, metadata: n.metadata, tags: n.tags })));
  const c = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--all", "--apply", "--backup-confirmed"], c), 0);
  const w = v.writes();
  assert.deepEqual(w.map((x) => [x.method, x.path]).sort(), [["PATCH", "/vault/default/api/notes/other"], ["PATCH", "/vault/default/api/notes/parent"]]);
  for (const p of w) {
    assert.ok(p.body.if_updated_at);
    assert.deepEqual(Object.keys(p.body).sort(), ["if_updated_at", "links"]);
    assert.equal(p.body.force, undefined);
    assert.equal(p.body.links.remove, undefined);
  }
  assert.deepEqual(w.find((x) => x.path.endsWith("/parent"))!.body.links.add, [{ target: "kid1", relationship: "mentions" }, { target: "kid2", relationship: "mentions" }]);
  // Bodies, metadata and tags are untouched everywhere.
  assert.deepEqual([...v.notes.values()].map((n) => ({ id: n.id, content: n.content, metadata: n.metadata, tags: n.tags })), before);
  const has = (s: string, t: string, r = "mentions") => v.links.some((l) => l.sourceId === s && l.targetId === t && l.relationship === r);
  assert.ok(has("parent", "kid1") && has("parent", "kid2") && has("other", "kid2") && has("other", "kid2", "related"));
  assert.ok(!has("parent", "binned") && !has("parent", "gone") && !has("parent", "parent") && !has("mail", "kid1") && !has("trashedParent", "kid1"));
  assert.equal(v.links.length, 5);
  assert.match(out(c), /done: 3 link\(s\) added on 2 note\(s\), 0 conflict/);
  noSecrets(c);
  const recs = c.undo.map((l) => JSON.parse(l) as UndoRecord);
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.kind === "vault-links" && r.script === "subpage-links"));
  assert.ok(!c.undo.join("\n").includes(BODY_SECRET), "the undo log holds no note text");

  // Idempotent: a second run finds nothing to add.
  const again = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--all", "--apply", "--backup-confirmed"], again), 0);
  assert.equal(v.writes().length, 2);
  assert.match(out(again), /0 link\(s\) to add on 0 note\(s\)/);

  // Undo works even after the parent was edited (it touches links only), and only removes what the log names.
  v.find("parent")!.content += "<p>edited later</p>";
  v.find("parent")!.updatedAt = v.stamp();
  const dry = ctxFor(v);
  assert.equal(await undo.main([...VAULT], dry, recs), 0);
  assert.equal(v.writes().length, 2);
  assert.match(out(dry), /would remove 2 link\(s\) from parent/);
  const u = ctxFor(v);
  assert.equal(await undo.main([...VAULT, "--apply"], u, recs), 0);
  const undoWrites = v.writes().slice(2);
  assert.equal(undoWrites.length, 2);
  for (const p of undoWrites) assert.deepEqual(Object.keys(p.body).sort(), ["if_updated_at", "links"]);
  assert.ok(!has("parent", "kid1") && !has("parent", "kid2") && !has("other", "kid2"));
  assert.ok(has("done", "kid1") && has("other", "kid2", "related"), "links the migration did not add are kept");
  assert.ok(v.find("parent")!.content!.includes("edited later"));
  // Undo twice: nothing left to remove, nothing written.
  const u2 = ctxFor(v);
  assert.equal(await undo.main([...VAULT, "--apply"], u2, recs), 0);
  assert.equal(v.writes().length, 4);
  assert.match(out(u2), /already gone/);
});

test("(g) apply: a concurrent edit is a conflict (skipped, not forced); a row removed meanwhile is not linked; --limit caps the writes", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  v.beforePatch = (id) => { if (id === "parent") v.find("parent")!.updatedAt = v.stamp(); };
  const c = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--all", "--apply", "--backup-confirmed"], c), 0);
  assert.match(out(c), /1 conflict\(s\)/);
  assert.ok(!v.links.some((l) => l.sourceId === "parent"));
  assert.equal(c.undo.length, 1);

  const v2 = new FakeVault();
  seedSubpages(v2);
  const c2 = ctxFor(v2);
  assert.equal(await subpageLinks.main([...VAULT, "--all", "--apply", "--backup-confirmed", "--limit", "1"], c2), 0);
  assert.equal(v2.writes().length, 1);

  // The row disappears between the listing and the fresh read: nothing is written for that note.
  const v3 = new FakeVault();
  seedSubpages(v3);
  const inner = v3.fetch;
  let listed = false;
  v3.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/api/notes") && u.searchParams.get("include_content") === "true") listed = true;
    else if (listed && u.pathname.endsWith("/notes/parent") && (init?.method ?? "GET") === "GET") v3.find("parent")!.content = "<p>rows removed</p>";
    return inner(input, init);
  }) as typeof fetch;
  const c3 = ctxFor(v3);
  assert.equal(await subpageLinks.main([...VAULT, "--all", "--apply", "--backup-confirmed"], c3), 0);
  assert.ok(!v3.links.some((l) => l.sourceId === "parent"));
  assert.match(out(c3), /1 unchanged/);
});

test("(g) scoping: --tag / --path-prefix read only those parents", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  const c = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--tag", "project"], c), 0);
  assert.match(out(c), /2 link\(s\) to add on 1 note\(s\)/);
  const c2 = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT, "--path-prefix", "vault/notes/"], c2), 0);
  assert.match(out(c2), /1 link\(s\) to add on 1 note\(s\)/);
  assert.equal(v.writes().length, 0);
});

test("(g) default scope: only notes with a live note under their own path are read — never a listing of every body", async () => {
  const v = new FakeVault();
  seedSubpages(v);
  v.add({ id: "home", path: "vault/notes/Home", content: `<p>${BODY_SECRET}</p>${row("sub")}${row("kid1")}` });
  v.add({ id: "sub", path: "vault/notes/Home/Sub" });
  const c = ctxFor(v);
  assert.equal(await subpageLinks.main([...VAULT], c), 0);
  assert.match(out(c), /DRY RUN — scanned 1 note\(s\); 1 hold sub-page rows \(2 row\(s\)\)/);
  assert.match(out(c), /2 link\(s\) to add on 1 note\(s\)/);
  assert.equal(v.writes().length, 0);
  assert.ok(!out(c).includes(BODY_SECRET));
});


// Project migration fixtures, selected with --test-name-pattern=project-pages.
test("project-pages: canonical membership, deepest folder, unknown values and human prose", () => {
  const v = new FakeVault();
  const p = v.add({id:"p",path:"vault/projects/alpha/PROJECT",tags:["project"],metadata:{title:"Alpha",slug:"alpha"}});
  v.add({id:"child",path:"vault/projects/alpha/nested/PROJECT",tags:["project"]});
  assert.deepEqual(projectPages.hygienePatch(v.add({id:"m",metadata:{project:"alpha",projects:["unknown"]}}),[...v.notes.values()]).metadata,{project:null});
  assert.deepEqual(projectPages.hygienePatch(v.add({id:"f",path:"vault/projects/alpha/nested/Notes"}),[...v.notes.values()]).metadata,{projects:["[[vault/projects/alpha/nested/PROJECT]]"]});
  const doc={...p,content:"# Alpha\n\nHuman purpose.\n\n## Key Context for Agents\nSecret agent prose.\n\n## Objectives\n- [ ] Human objective.\n"};
  const change=projectPages.hygienePatch(doc,[p]);
  assert.ok(change.content!.includes("Human objective"));assert.ok(change.content!.includes("Human purpose"));assert.ok(!change.content!.includes("Secret agent"));assert.match(String(change.metadata!.agent_context),/Secret agent prose/);
});
test("project-pages: missing folders and only approved nested promotions",()=>{
 const notes=[{id:"a",path:"vault/projects/missing/Note"},{id:"b",path:"vault/projects/opencivics/icfc/Note"},{id:"c",path:"vault/projects/opencivics/other/Note"}];
 assert.deepEqual(projectPages.missingProjects(notes).map(x=>x.path),["vault/projects/missing/PROJECT","vault/projects/opencivics/PROJECT","vault/projects/opencivics/icfc/PROJECT"]);
});
test("project-pages: dryrun prints no bodies, apply requires backup and CAS conflict preserves notes",async()=>{
 const v=new FakeVault();const p=v.add({id:"p",path:"vault/projects/alpha/PROJECT",tags:["project"],metadata:{title:"Alpha"},content:"# Alpha\n\nBODY_SECRET"});const c=ctxFor(v);
 assert.equal(await projectPages.main(VAULT,c),0);assert.equal(v.writes().length,0);assert.ok(!out(c).includes("BODY_SECRET"));
 await assert.rejects(()=>projectPages.main([...VAULT,"--apply"],c),/backup-confirmed/);
 v.beforePatch=id=>{v.notes.get(id)!.updatedAt=v.stamp();};
 assert.equal(await projectPages.main([...VAULT,"--apply","--backup-confirmed"],c),1);assert.equal(p.content,"# Alpha\n\nBODY_SECRET");
});
test("project-pages: repair creates, archives, repoints IDs and links before Trash, undo restores",async()=>{
 const v=new FakeVault();v.add({id:"canonical",path:"vault/projects/eth-boulder/PROJECT",tags:["project"],metadata:{title:"ETH Boulder"},content:"Human canonical."});
 v.add({id:"dup",path:"vault/projects/ethboulder/PROJECT",tags:["project"],metadata:{title:"Other"},content:"DUPLICATE_BODY ".repeat(4000)});
 const member=v.add({id:"member",path:"Notes/member",metadata:{projects:["dup"]},content:"[[vault/projects/ethboulder/PROJECT|Old]]"});
 v.links.push({sourceId:"member",targetId:"dup",relationship:"project"});
 v.add({id:"large",path:"vault/projects/large/PROJECT",tags:["project"],content:"ORIGINAL_BODY ".repeat(4000)});
 v.add({id:"missing",path:"vault/projects/new-project/Note"});
 const c=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});const argv=[...VAULT,"--phase","repair","--prism-url","http://prism.test:8888","--apply","--backup-confirmed"];
 assert.equal(await projectPages.main(argv,c),0,out(c));
 assert.deepEqual(member.metadata!.projects,["[[vault/projects/eth-boulder/PROJECT]]"]);assert.equal(member.content,"[[vault/projects/ethboulder/PROJECT|Old]]");assert.ok(v.notes.get("canonical")!.metadata!.aliases instanceof Array);
 assert.equal(v.links[0]!.targetId,"canonical");assert.ok(v.notes.get("dup")!.tags!.includes("prism-trashed"));
 assert.match(v.find("vault/projects/eth-boulder/Merged project ethboulder")!.content!,/Project background/);
 assert.match(v.find("vault/projects/large/Project background")!.content!,/^ORIGINAL_BODY/);assert.ok(v.find("vault/projects/new-project/PROJECT"));
 const count=v.writes().length;assert.equal(await projectPages.main(argv,c),0);assert.equal(v.writes().length,count,"rerun is idempotent");
 assert.equal(await undo.main([...VAULT,"--prism-url","http://prism.test:8888","--apply"],c,c.undo.map(x=>JSON.parse(x))),0);
 assert.deepEqual(member.metadata!.projects,["dup"]);assert.equal(v.links[0]!.targetId,"dup");assert.equal(member.content,"[[vault/projects/ethboulder/PROJECT|Old]]");
 assert.ok(!v.notes.get("dup")!.tags!.includes("prism-trashed"));assert.equal(v.notes.get("dup")!.content,"DUPLICATE_BODY ".repeat(4000));assert.ok(v.find("vault/projects/new-project/PROJECT")!.tags!.includes("prism-trashed"));
 noSecrets(c);
});
test("project-pages: generated indexes are gated and human prose blocks retirement",async()=>{
 const v=new FakeVault();v.add({id:"pure",path:"vault/projects/a/INDEX",content:"# Index\n```dataview\nTABLE title\n```"});v.add({id:"human",path:"vault/projects/a/index",content:"Human prose.\n```dataview\nTABLE title\n```"});
 const c=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});await assert.rejects(()=>projectPages.main([...VAULT,"--phase","indexes"],c),/live-sections-confirmed/);
 assert.equal(await projectPages.main([...VAULT,"--phase","indexes","--live-sections-confirmed","--prism-url","http://prism.test","--apply","--backup-confirmed"],c),0);
 assert.ok(v.notes.get("pure")!.tags!.includes("prism-trashed"));assert.ok(!v.notes.get("human")!.tags!.includes("prism-trashed"));
});

test("project-pages: merge conflict leaves the duplicate live and later edits survive undo",async()=>{
 const v=new FakeVault();v.add({id:"canon",path:"vault/projects/eth-boulder/PROJECT",tags:["project"]});v.add({id:"dup",path:"vault/projects/ethboulder/PROJECT",tags:["project"],content:"Preserved original"});
 const m=v.add({id:"m",metadata:{project:"dup"},content:"Original"});const c=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});const argv=[...VAULT,"--phase","repair","--prism-url","http://prism.test","--apply","--backup-confirmed"];
 v.beforePatch=id=>{if(id==="m")v.notes.get(id)!.updatedAt=v.stamp();};
 assert.equal(await projectPages.main(argv,c),1);assert.ok(!v.notes.get("dup")!.tags!.includes("prism-trashed"));
 v.beforePatch=undefined;assert.equal(await projectPages.main(argv,c),0);
 m.content="Later human edit";m.updatedAt=v.stamp();
 assert.equal(await undo.main([...VAULT,"--prism-url","http://prism.test","--apply"],c,c.undo.map(x=>JSON.parse(x))),0);
 assert.equal(m.content,"Later human edit");assert.deepEqual(m.metadata!.projects,["[[vault/projects/eth-boulder/PROJECT]]"]);
});

test("project-pages: legacy folder projects and descendant pages prevent cascading Trash",async()=>{
 const v=new FakeVault();v.add({id:"legacy",path:"vault/projects/legacy",tags:["project"]});v.add({id:"legacychild",path:"vault/projects/legacy/Note"});
 assert.deepEqual(projectPages.missingProjects([...v.notes.values()]),[]);
 v.add({id:"canon",path:"vault/projects/eth-boulder/PROJECT",tags:["project"]});v.add({id:"dup",path:"vault/projects/ethboulder/PROJECT",tags:["project"]});v.add({id:"child",path:"vault/projects/ethboulder/PROJECT/Child"});
 const c=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});assert.equal(await projectPages.main([...VAULT,"--phase","repair","--prism-url","http://prism.test","--apply","--backup-confirmed"],c),1);
 assert.ok(!v.notes.get("dup")!.tags!.includes("prism-trashed"));assert.ok(!v.find("vault/projects/eth-boulder/Merged project ethboulder"));
});

test("project-pages: partial Trash response is a failed migration, not success",async()=>{
 const v=new FakeVault();v.add({id:"pure",path:"vault/projects/a/INDEX",content:"```dataview\nTABLE title\n```"});const c=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});const original=c.fetch;
 c.fetch=async(input,init)=>{const url=new URL(String(input));if(url.pathname.endsWith("/trash")){assert.equal(JSON.parse(String(init?.body)).require_leaf,true);return Response.json({ok:false,error:"partial_trash"},{status:207});}return original(input,init);};
 assert.equal(await projectPages.main([...VAULT,"--phase","indexes","--live-sections-confirmed","--prism-url","http://prism.test","--apply","--backup-confirmed"],c),1);
 assert.equal(c.undo.length,0);assert.ok(!v.notes.get("pure")!.tags!.includes("prism-trashed"));
});


test("project-pages: repair preview and apply share snapshot; new canonical merges need next preview", async () => {
 const v=new FakeVault();
 v.add({id:"folder-note",path:"vault/projects/eth-boulder/Notes"});
 v.add({id:"duplicate",path:"vault/projects/ethboulder/PROJECT",tags:["project"],content:"Preserved duplicate"});
 const argv=[...VAULT,"--phase","repair","--prism-url","http://prism.test"];
 const preview=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});
 assert.equal(await projectPages.main(argv,preview),0,out(preview));
 assert.match(out(preview),/done: 1 planned, 0 writes, 0 failed/);
 assert.doesNotMatch(out(preview),/would trash|Merged project/);
 const apply=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});
 assert.equal(await projectPages.main([...argv,"--apply","--backup-confirmed"],apply),0,out(apply));
 assert.match(out(apply),/done: 1 planned, 1 writes, 0 failed/);
 assert.ok(!v.notes.get("duplicate")!.tags!.includes("prism-trashed"));
 assert.ok(!v.find("vault/projects/eth-boulder/Merged project ethboulder"));
 const writes=v.writes().length;
 const next=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});
 assert.equal(await projectPages.main(argv,next),0,out(next));
 assert.match(out(next),/would create vault\/projects\/eth-boulder\/Merged project ethboulder/);
 assert.match(out(next),/would trash duplicate/);
 assert.equal(v.writes().length,writes,"second preview remains read-only");
});


test("project-pages: repair merge touches only duplicate membership and previews exact typed links", async () => {
 const v=new FakeVault();
 const canonical=v.add({id:"canonical",path:"vault/projects/eth-boulder/PROJECT",tags:["project"]});
 const duplicate=v.add({id:"duplicate",path:"vault/projects/ethboulder/PROJECT",tags:["project"],content:"Preserved"});
 v.add({id:"other",path:"vault/projects/other/PROJECT",tags:["project"]});
 const unrelated=v.add({id:"unrelated",path:"vault/projects/other/Notes",metadata:{project:"other",projects:["other"]}});
 const child=v.add({id:"unassigned",path:"vault/projects/other/Unassigned",metadata:{}});
 const member=v.add({id:"member",metadata:{projects:["duplicate","other","unknown"],project:"unrelated-legacy"}});
 v.links.push({sourceId:"member",targetId:"duplicate",relationship:"project"});
 const argv=[...VAULT,"--phase","repair","--prism-url","http://prism.test"];
 const preview=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});
 assert.equal(await projectPages.main(argv,preview),0,out(preview));
 assert.match(out(preview),/done: 5 planned, 0 writes, 0 failed/);
 assert.match(out(preview),/would links member \{"add":\[\{"target":"canonical","relationship":"project"\}\],"remove":\[\{"target":"duplicate","relationship":"project"\}\]\}/);
 assert.doesNotMatch(out(preview),/would patch unrelated|would patch unassigned/);
 assert.equal(v.writes().length,0);
 const apply=ctxFor(v,{PRISM_OWNER_TOKEN:OWNER});
 assert.equal(await projectPages.main([...argv,"--apply","--backup-confirmed"],apply),0,out(apply));
 assert.match(out(apply),/done: 5 planned, 5 writes, 0 failed/);
 assert.deepEqual(member.metadata!.projects,["[[vault/projects/eth-boulder/PROJECT]]","other","unknown"]);
 assert.equal(member.metadata!.project,"unrelated-legacy");
 assert.deepEqual(unrelated.metadata,{project:"other",projects:["other"]});assert.deepEqual(child.metadata,{});
 assert.equal(v.links[0]!.targetId,"canonical");
});


test("project-pages: merge repair preserves ambiguous aliases and unrelated legacy fields", () => {
 const duplicate={id:"dup",path:"vault/projects/ethboulder/PROJECT",tags:["project"],metadata:{aliases:["shared","unique"]}};
 const canonical={id:"canonical",path:"vault/projects/eth-boulder/PROJECT",tags:["project"]};
 const other={id:"other",path:"vault/projects/other/PROJECT",tags:["project"],metadata:{aliases:["shared"]}};
 assert.deepEqual(projectPages.mergeMembershipPatch({id:"member",metadata:{projects:["shared","unique","other"],project:"unrelated"}},duplicate,canonical,[duplicate,canonical,other]),{metadata:{projects:["shared","[[vault/projects/eth-boulder/PROJECT]]","other"]}});
});


test("project-pages: compact hygiene summary separates content/membership/agent fields without prose or titles", async () => {
 const v=new FakeVault();
 v.add({id:"project1",path:"vault/projects/alpha/PROJECT",tags:["project"],metadata:{title:"PRIVATE_TITLE"},content:"# PRIVATE_TITLE\n\nHuman prose.\n\n## Key Context for Agents\nPRIVATE_AGENT_PROSE\n"});
 v.add({id:"member1",path:"vault/projects/alpha/PRIVATE_CHILD",metadata:{}});
 const c=ctxFor(v);assert.equal(await projectPages.main([...VAULT,"--summary-only"],c),0,out(c));
 const summary=JSON.parse(out(c).split("\n").find(line=>line.startsWith("summary: "))!.slice(9));
 assert.deepEqual(summary,{creates:0,patches:2,content:1,membership:1,agentContext:1,otherMetadata:0,metadataFields:{agent_context:1,projects:1},linkOperations:0,linksAdded:0,linksRemoved:0,trash:0});
 assert.doesNotMatch(out(c),/PRIVATE_TITLE|PRIVATE_AGENT_PROSE|PRIVATE_CHILD|would patch/);
 assert.equal(v.writes().length,0);
});


test("project-pages: retired duplicate folder aliases backfill absent membership without touching explicit values", () => {
 const canonical: VaultNote={id:"canonical",path:"vault/projects/bioregional-food-chain/PROJECT",tags:["project"],metadata:{aliases:["retired-id","Bioregional Foodchain Design","vault/projects/bioregional-foodchain-design/PROJECT","vault/projects/bioregional-foodchain-design","bioregional-foodchain-design"]}};
 const retired: VaultNote={id:"retired-id",path:"vault/projects/bioregional-foodchain-design/PROJECT",tags:["project","prism-trashed"]};
 const draft: VaultNote={id:"proposal",path:"vault/projects/bioregional-foodchain-design/proposal-draft-v1",content:"Substantive proposal, unchanged.",metadata:{}};
 const notes=[canonical,retired,draft];
 assert.deepEqual(projectPages.hygienePatch(draft,notes),{metadata:{projects:["[[vault/projects/bioregional-food-chain/PROJECT]]"]}});
 assert.deepEqual(projectPages.hygienePatch({...draft,metadata:{projects:["unknown-explicit"]}},notes),{});
 assert.deepEqual(projectPages.hygienePatch({...draft,metadata:{projects:["[[vault/projects/another/PROJECT]]"]}},notes),{});
 assert.deepEqual(projectPages.hygienePatch({...draft,path:"vault/projects/Bioregional Foodchain Design/proposal"},notes),{},"a display title is not a folder alias");
 assert.deepEqual(projectPages.hygienePatch({...draft,path:"vault/projects/bioregional-foodchain-design-extra/proposal"},notes),{},"folder matching respects the slash boundary");
});

test("project-pages: deepest alias folder wins; alias collisions and active folder ownership fail closed", () => {
 const outer: VaultNote={id:"outer",path:"vault/projects/canonical/PROJECT",tags:["project"],metadata:{aliases:["vault/projects/old"]}};
 const nested: VaultNote={id:"nested",path:"vault/projects/child/PROJECT",tags:["project"],metadata:{aliases:["[[vault/projects/old/nested/PROJECT.md]]"]}};
 const note: VaultNote={id:"note",path:"vault/projects/old/nested/Notes"};
 assert.equal(projectPages.inferAncestorProject(note,[outer,nested])?.id,"nested");
 const collision: VaultNote={id:"collision",path:"vault/projects/elsewhere/PROJECT",tags:["project"],metadata:{aliases:["vault/projects/old/nested"]}};
 assert.equal(projectPages.inferAncestorProject(note,[outer,nested,collision]),undefined,"ambiguous deepest match must not fall back to outer");
 const active: VaultNote={id:"active",path:"vault/projects/old/nested/PROJECT",tags:["project"]};
 assert.equal(projectPages.inferAncestorProject(note,[outer,nested,active]),undefined,"alias cannot take an active project's folder");
 assert.equal(projectPages.inferAncestorProject({...note,tags:["prism-trashed"]},[outer,nested]),undefined);
});


test("project-pages: canonical folder named project is retained exactly", () => {
 const project: VaultNote={id:"nested-project",path:"vault/projects/outer/project/PROJECT",tags:["project"]};
 assert.equal(projectPages.inferAncestorProject({id:"inside",path:"vault/projects/outer/project/note"},[project])?.id,"nested-project");
 assert.equal(projectPages.inferAncestorProject({id:"sibling",path:"vault/projects/outer/note"},[project]),undefined);
});
