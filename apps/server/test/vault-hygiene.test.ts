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
import * as fieldShapes from "../../../scripts/vault-hygiene/migrate-field-shapes";
import { LIST_FIELDS_BY_TAG } from "../src/vault-shapes";
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
  for (const m of [schema.main, emptyLists.main, fieldShapes.main, folderLinks.main, dups.main, untagged.main]) {
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
  const t0 = Date.now();
  fieldShapes.splitOutsideLinks("[[".repeat(200_000) + ",".repeat(200_000));
  assert.ok(Date.now() - t0 < 1500, "linear on hostile input");
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
