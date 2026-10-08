/**
 * Relation fields (A/B/C): one-step property creation, relation targets and
 * reading the four stored encodings of a relation value.
 *   - pure: target inference from a property's name, value resolution (full-path
 *     wikilink, dangling folder link, bare slug, name / address, ""), hint
 *     validation, the one-step patch builder, where a new target page goes;
 *   - server: one PUT carries the vault field + every hint, `multiple` must agree
 *     with the stored type, a folder target replaces a tag target, and the
 *     owner-only, dry-run-first backfill writes only `relationTag` hints.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { listActionAudit } from "../src/actions/store";
import {
  buildNewPropertyPatch,
  buildRelationIndex,
  conventionalPath,
  inferRelationTarget,
  mergeFieldHints,
  planRelationTargets,
  propertyFromField,
  relationValues,
  resolveProperties,
  resolveRelationValue,
  validateSchemaPatch,
  type RelationCandidate,
} from "@prism/core/database";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

// ── pure ─────────────────────────────────────────────────────────────────────

const KNOWN = ["project", "person", "organization", "meeting", "task", "email", "transcript"];

test("target inference: plural and people names map to a known tag; anything unsure is null", () => {
  const cases: Array<[string, string | null]> = [
    ["projects", "project"], ["project", "project"], ["Projects", "project"],
    ["people", "person"], ["attendees", "person"], ["participants", "person"], ["assignee", "person"], ["owner", "person"],
    ["organizations", "organization"], ["organization", "organization"], ["org", "organization"],
    ["meetings", "meeting"], ["tasks", "task"], ["transcripts", "transcript"],
    // Not relations, or nothing to point at: never a guess.
    ["email", null], ["meeting", null], ["status", null], ["related", null], ["epic", null], ["notes", null],
  ];
  for (const [key, want] of cases) assert.equal(inferRelationTarget(key, KNOWN), want, key);
  // Only tags that exist count.
  assert.equal(inferRelationTarget("projects", ["person"]), null);
  assert.equal(inferRelationTarget("attendees", []), null);
});

const projects: RelationCandidate[] = [
  { id: "p1", path: "vault/projects/prism/PROJECT", title: "Prism" },
  { id: "p2", path: "vault/projects/spirit-of-the-front-range/PROJECT", title: "Spirit of the Front Range", aliases: ["SOFR"] },
  { id: "p3", path: "vault/projects/localism-fund/PROJECT", title: "Localism Fund" },
];
const people: RelationCandidate[] = [
  { id: "a", path: "vault/people/Ada Lovelace", title: "Ada Lovelace", emails: ["ada@example.org"] },
  { id: "b", path: "vault/people/ada-twin", title: "Ada Twin" },
  { id: "c1", path: "vault/people/Sam One", title: "Sam" },
  { id: "c2", path: "vault/people/Sam Two", title: "Sam" },
];

test("value resolution reads all four encodings, exactly or not at all", () => {
  const p = buildRelationIndex(projects);
  const via = (v: string) => { const r = resolveRelationValue(v, p); return r.kind === "note" ? `${r.note.id}:${r.via}` : r.kind; };
  // 1. full-path wikilink (case and `.md` as the vault compares paths)
  assert.equal(via("[[vault/projects/prism/PROJECT]]"), "p1:path");
  assert.equal(via("[[vault/projects/Prism/PROJECT.md]]"), "p1:path");
  assert.equal(via("[[vault/projects/prism/PROJECT|the app]]"), "p1:path");
  // 2. a folder link that dangles → the folder's own note
  assert.equal(via("[[vault/projects/localism-fund]]"), "p3:folder");
  assert.equal(via("vault/projects/prism"), "p1:folder"); // a raw path
  // 3. a bare slug
  assert.equal(via("spirit-of-the-front-range"), "p2:slug");
  assert.equal(via("prism"), "p1:slug");
  // 4. a name or alias
  assert.equal(via("Spirit of the Front Range"), "p2:name");
  assert.equal(via("sofr"), "p2:slug".replace("slug", "name"));
  assert.equal(via("Localism Fund"), "p3:name");
  // Nothing partial, nothing outside the target.
  assert.equal(via("Spirit"), "none");
  assert.equal(via("[[vault/projects/nope]]"), "none");
  assert.equal(via(""), "none");

  const ppl = buildRelationIndex(people);
  const pv = (v: string) => { const r = resolveRelationValue(v, ppl); return r.kind === "note" ? `${r.note.id}:${r.via}` : r.kind; };
  assert.equal(pv("ada@example.org"), "a:email");
  assert.equal(pv("ADA@example.org"), "a:email");
  assert.equal(pv("nobody@example.org"), "none"); // an address never falls back to a name
  assert.equal(pv("[[vault/people/Ada Lovelace]]"), "a:path");
  assert.equal(pv("[[Ada Lovelace]]"), "a:name"); // a bare-name wikilink
  assert.equal(pv("Sam"), "ambiguous"); // two people called Sam: never linked
});

test("\"\" and blank list items are empty; lists keep their order", () => {
  assert.deepEqual(relationValues(""), []);
  assert.deepEqual(relationValues(null), []);
  assert.deepEqual(relationValues(["", " ", "[[a/b]]", "c"]), ["[[a/b]]", "c"]);
  assert.deepEqual(relationValues("prism"), ["prism"]);
});

test("a declared relation-named field with a target is a relation whatever its value; a free key keeps its kind", () => {
  // task.project: vault string holding a bare slug (vault-health §8) → relation to #project.
  const def = propertyFromField("project", { type: "string" }, "task", "spirit-of-the-front-range", KNOWN);
  assert.equal(def.kind, "relation");
  assert.equal(def.target, "project");
  assert.equal(def.targetInferred, true);
  assert.equal(def.multiple, false);
  // meeting.projects: array → relation, several.
  const many = propertyFromField("projects", { type: "array" }, "meeting", ["[[vault/projects/prism/PROJECT]]"], KNOWN);
  assert.deepEqual([many.kind, many.target, many.multiple], ["relation", "project", true]);
  // "meetings" (array, no RELATION_KEYS word) → relation through the plural rule.
  assert.equal(propertyFromField("meetings", { type: "array" }, "project", [], KNOWN).kind, "relation");
  // An owner's kind hint always wins.
  assert.equal(propertyFromField("project", { type: "string", kind: "text" }, "task", "x", KNOWN).kind, "text");
  // No target known → the old rule (text until the value is a wikilink).
  assert.equal(propertyFromField("project", { type: "string" }, "task", "prism", ["person"]).kind, "text");
  // A free key (no schema) is decided by its value only, as before.
  assert.equal(propertyFromField("owner", {}, null, "Alex Chen", KNOWN).kind, "text");
  // A hinted folder target.
  const folder = propertyFromField("area", { type: "string", relationTarget: { pathPrefix: "vault/areas" } }, "task", null, KNOWN);
  assert.deepEqual([folder.kind, folder.targetPath, folder.target], ["relation", "vault/areas", undefined]);
  // resolveProperties passes the known tags through.
  const props = resolveProperties(["task"], { task: { description: null, fields: { project: { type: "string" } } }, project: { description: null, fields: {} } }, { project: "prism" });
  assert.equal(props.find((p) => p.key === "project")?.kind, "relation");
});

test("hint validation: relationTarget is {tag} or a safe folder; multiple is boolean", () => {
  const ok = (ui: unknown) => validateSchemaPatch({ ui: { project: ui } });
  assert.deepEqual((ok({ relationTarget: { tag: "#project" } }) as any).patch.ui.project.relationTarget, { tag: "project" });
  assert.deepEqual((ok({ relationTarget: { pathPrefix: "vault/projects/" } }) as any).patch.ui.project.relationTarget, { pathPrefix: "vault/projects" });
  for (const bad of [{ pathPrefix: "/abs" }, { pathPrefix: "a/../b" }, { pathPrefix: "a\\b" }, { pathPrefix: "a//b" }, { tag: "" }, { tag: "x", pathPrefix: "y" }, "project", { other: 1 }]) {
    assert.equal(ok({ relationTarget: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(ok({ multiple: "yes" }).ok, false);
  assert.equal((ok({ multiple: true }) as any).patch.ui.project.multiple, true);
  // Merging keeps relationTag and relationTarget in step.
  assert.deepEqual(mergeFieldHints({ label: "P" }, { relationTag: "project" }), { label: "P", relationTag: "project", relationTarget: { tag: "project" } });
  assert.deepEqual(mergeFieldHints({ relationTag: "project", relationTarget: { tag: "project" } }, { relationTarget: { pathPrefix: "vault/p" } }), { relationTarget: { pathPrefix: "vault/p" } });
});

test("one-step patch: field + options + colours + groups + format + target in one write", () => {
  const status = buildNewPropertyPatch({ label: "Stage", kind: "status", options: [{ value: "Idea", color: "gray", group: "todo" }, { value: "Building", color: "blue", group: "in_progress" }, { value: "Shipped", color: "green", group: "complete" }] });
  assert.ok(status.ok);
  assert.deepEqual(status.ok && status.patch, {
    fields: { stage: { type: "string", enum: ["Idea", "Building", "Shipped"] } },
    ui: { stage: { kind: "status", label: "Stage", colors: { Idea: "gray", Building: "blue", Shipped: "green" }, optionOrder: ["Idea", "Building", "Shipped"], statusGroups: { Idea: "todo", Building: "in_progress", Shipped: "complete" } } },
  });
  assert.ok(validateSchemaPatch(status.ok && status.patch).ok, "the server accepts it");
  // Multi-select options are hints (the vault validates enum on strings only).
  const multi = buildNewPropertyPatch({ label: "Labels", kind: "multi_select", options: [{ value: "a" }, { value: "b" }] });
  assert.deepEqual(multi.ok && multi.patch.fields, { labels: { type: "array" } });
  // A number with the default format sends no hint for it.
  const n = buildNewPropertyPatch({ label: "Effort", kind: "number" });
  assert.deepEqual(n.ok && n.patch, { fields: { effort: { type: "number" } }, ui: { effort: { kind: "number", label: "Effort" } } });
  const usd = buildNewPropertyPatch({ label: "Budget", kind: "number", format: "usd" });
  assert.equal(usd.ok && usd.patch.ui!.budget!.format, "usd");
  // Relation: several → array; target tag as `relationTag` (every client reads it).
  const rel = buildNewPropertyPatch({ label: "Projects", kind: "relation", target: { tag: "project" }, multiple: true, reverseLabel: "Tasks" });
  assert.deepEqual(rel.ok && rel.patch, { fields: { projects: { type: "array" } }, ui: { projects: { kind: "relation", label: "Projects", relationTag: "project", multiple: true, reverseLabel: "Tasks" } } });
  const folder = buildNewPropertyPatch({ label: "Area", kind: "relation", target: { pathPrefix: "vault/areas" }, multiple: false });
  assert.deepEqual(folder.ok && folder.patch.ui!.area, { kind: "relation", label: "Area", relationTarget: { pathPrefix: "vault/areas" }, multiple: false });
  // Refusals are said, never sent.
  assert.equal(buildNewPropertyPatch({ label: "S", kind: "select", options: [{ value: "a" }, { value: "A" }] }).ok, false);
  assert.equal(buildNewPropertyPatch({ label: "  ", kind: "text" }).ok, false);
  assert.equal(buildNewPropertyPatch({ label: "X", kind: "relation", target: { pathPrefix: "../x" } }).ok, false);
});

test("a new target page goes beside the target's pages (folder convention first)", () => {
  const projectPaths = projects.map((p) => p.path);
  assert.equal(conventionalPath({ tag: "project" }, projectPaths, "New Thing"), "vault/projects/new-thing/PROJECT");
  assert.equal(conventionalPath({ tag: "project" }, projectPaths, "Prism"), "vault/projects/prism-2/PROJECT");
  assert.equal(conventionalPath({ tag: "person" }, ["vault/people/A", "vault/people/B"], "Cy Young"), "vault/people/Cy Young");
  assert.equal(conventionalPath({ tag: "person" }, ["vault/people/Cy Young"], "Cy Young"), "vault/people/Cy Young 2");
  assert.equal(conventionalPath({ pathPrefix: "vault/areas" }, [], "Garden"), "vault/areas/Garden");
  assert.equal(conventionalPath({ tag: "thing" }, [], "a/b"), "a-b");
});

test("backfill plan: proposals from names, unresolved listed, set targets left alone", () => {
  const plan = planRelationTargets({
    task: { description: null, fields: { project: { type: "string" }, assigned: { type: "string" }, status: { type: "string", enum: ["a"] }, epic: { type: "string" } } },
    meeting: { description: null, fields: { projects: { type: "array" }, attendees: { type: "array" }, date: { type: "string" } } },
    organization: { description: null, fields: { projects: { type: "array", relationTag: "project" }, people: { type: "array" } } },
    project: { description: null, fields: { estimate: { type: "number" } } },
    person: { description: null, fields: {} },
    "governance-role": { description: null, fields: { projects: { type: "array" } } },
  }, (t) => t.startsWith("governance-"));
  const key = (x: { tag: string; field: string }) => `${x.tag}.${x.field}`;
  assert.deepEqual(plan.proposals.map((p) => `${key(p)}→${p.target}`).sort(), ["meeting.attendees→person", "meeting.projects→project", "organization.people→person", "task.assigned→person", "task.project→project"]);
  assert.deepEqual(plan.unresolved.map(key), ["task.epic"]);
  assert.equal(plan.alreadySet, 1);
});

test("dry-run findings (2026-10-08): contact is not a person link; chat/mail tags get no hints; a name with a slash still resolves", () => {
  assert.equal(inferRelationTarget("contact", KNOWN), null, "a person's own contact address is not a link to someone else");
  assert.equal(inferRelationTarget("contacts", KNOWN), null);
  const plan = planRelationTargets({
    person: { description: null, fields: { contact: { type: "string" }, projects: { type: "array" } } },
    "message-thread": { description: null, fields: { participants: { type: "array" } } },
    email: { description: null, fields: { to: { type: "string" } } },
  });
  const keys = [...plan.proposals, ...plan.unresolved].map((x) => `${x.tag}.${x.field}`);
  assert.ok(keys.includes("person.projects"));
  assert.ok(!keys.includes("person.contact"), "contact is never proposed");
  assert.ok(!keys.some((k) => k.startsWith("message-thread.") || k.startsWith("email.")), "ingested chat/mail people fields are skipped");
  const sprint: RelationCandidate[] = [{ id: "s6", path: "vault/projects/x/sprints/sprint-6", title: "Sprint 6 (10/6 - 10/20)", aliases: [], emails: [] }];
  const r = resolveRelationValue("Sprint 6 (10/6 - 10/20)", buildRelationIndex(sprint));
  assert.equal(r.kind === "note" ? r.note.id : r.kind, "s6");
  assert.equal(resolveRelationValue("[[Sprint 6 (10/6 - 10/20)]]", buildRelationIndex(sprint)).kind, "none", "a [[link]] with a slash stays a path");
});

// ── server ───────────────────────────────────────────────────────────────────

let fv: FakeVault;
let vaultTags: Array<{ name: string; count: number; description: string | null; fields: Record<string, unknown> }>;
let tagPuts: Array<{ tag: string; body: any }>;
let innerFetch: typeof fetch;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  vaultTags = [
    { name: "task", count: 2, description: null, fields: { project: { type: "string" }, status: { type: "string", enum: ["todo", "done"] }, epic: { type: "string" } } },
    { name: "meeting", count: 1, description: null, fields: { projects: { type: "array" }, attendees: { type: "array" } } },
    { name: "project", count: 2, description: "Projects", fields: {} },
    { name: "person", count: 1, description: "People", fields: {} },
  ];
  tagPuts = [];
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = url.pathname.match(/^\/vault\/default\/api\/tags(?:\/([^/]+))?$/);
    if (m && !m[1] && (init?.method ?? "GET") === "GET") return Response.json(vaultTags);
    if (m && m[1] && init?.method === "PUT") {
      const tag = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init.body));
      tagPuts.push({ tag, body });
      const row = vaultTags.find((t) => t.name === tag);
      if (row) Object.assign(row, { description: body.description, fields: body.fields });
      else vaultTags.push({ name: tag, count: 0, description: body.description, fields: body.fields });
      return Response.json({ ok: true });
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
  process.env.SCHEMA_WRITES_PER_MINUTE = "1000000";
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
const put = (tag: string, body: unknown, cookie = login(OWNER)) => req(`/schemas/${encodeURIComponent(tag)}`, { method: "PUT", cookie, headers: J, body: JSON.stringify(body) });
const fieldsOf = async (tag: string) => ((await (await req(`/schemas?tags=${tag}`, { cookie: login(OWNER) })).json()) as any).schemas[tag].fields as Record<string, any>;
const backfill = (body: unknown, cookie = login(OWNER)) => req("/schemas/relation-targets", { method: "POST", cookie, headers: J, body: JSON.stringify(body) });

test("one PUT creates the field with its options and every hint", async () => {
  const built = buildNewPropertyPatch({ label: "Stage", kind: "status", options: [{ value: "Idea", color: "gray", group: "todo" }, { value: "Done", color: "green", group: "complete" }] });
  assert.ok(built.ok);
  const r = await put("task", built.ok && built.patch);
  assert.equal(r.status, 200);
  assert.equal(tagPuts.length, 1, "one vault schema write");
  assert.deepEqual(tagPuts[0]!.body.fields.stage, { type: "string", enum: ["Idea", "Done"] });
  const f = await fieldsOf("task");
  assert.deepEqual(f.stage.statusGroups, { Idea: "todo", Done: "complete" });
  assert.deepEqual(f.stage.colors, { Idea: "gray", Done: "green" });
  assert.equal(f.stage.kind, "status");
  // A refused part refuses the whole write: nothing reaches the vault.
  const bad = await put("task", { fields: { size: { type: "number" } }, ui: { size: { kind: "select" } } });
  assert.equal(bad.status, 409);
  assert.equal(tagPuts.length, 1);
  assert.equal((await fieldsOf("task")).size, undefined);
});

test("relation hints: multiple must agree with the stored type; a folder target replaces a tag target", async () => {
  assert.equal((await put("task", { ui: { project: { multiple: true } } })).status, 409, "a string field holds one page");
  assert.equal((await put("meeting", { ui: { projects: { multiple: false } } })).status, 409, "an array field holds several");
  assert.equal((await put("meeting", { ui: { projects: { multiple: true, relationTag: "project" } } })).status, 200);
  let f = (await fieldsOf("meeting")).projects;
  assert.deepEqual([f.relationTag, f.relationTarget, f.multiple], ["project", { tag: "project" }, true]);
  assert.equal((await put("meeting", { ui: { projects: { relationTarget: { pathPrefix: "vault/projects" } } } })).status, 200);
  f = (await fieldsOf("meeting")).projects;
  assert.deepEqual([f.relationTag, f.relationTarget], [undefined, { pathPrefix: "vault/projects" }]);
  assert.equal(tagPuts.length, 0, "hints only: the vault schema never moved");
  // A new relation that holds several is created as an array.
  const rel = buildNewPropertyPatch({ label: "People", kind: "person", target: { tag: "person" }, multiple: true });
  assert.equal((await put("task", rel.ok && rel.patch)).status, 200);
  assert.deepEqual(tagPuts.at(-1)!.body.fields.people, { type: "array" });
});

test("relation-target backfill: owner-only, dry run lists, write sets only hints and never touches a note", async () => {
  fv.put({ id: "t1", path: "Tasks/One", tags: ["task"], content: "", metadata: { title: "One", project: "prism" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  assert.equal((await backfill({}, login("member@test.local"))).status, 403);
  assert.equal((await backfill({ dryRun: "no" })).status, 400);
  const dry = await backfill({});
  assert.equal(dry.status, 200);
  const plan = (await dry.json()) as any;
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.proposals.map((p: any) => `${p.tag}.${p.field}→${p.target}`).sort(), ["meeting.attendees→person", "meeting.projects→project", "task.project→project"]);
  assert.deepEqual(plan.unresolved.map((p: any) => `${p.tag}.${p.field}`), ["task.epic"]);
  assert.equal((await fieldsOf("task")).project.relationTag, undefined, "a dry run writes nothing");

  // An owner's own target is never overwritten by the backfill.
  assert.equal((await put("meeting", { ui: { attendees: { relationTarget: { pathPrefix: "vault/people" } } } })).status, 200);
  const before = fv.calls.length;
  const run = await backfill({ dryRun: false });
  assert.equal(run.status, 200);
  const out = (await run.json()) as any;
  assert.equal(out.written, 2);
  assert.equal((await fieldsOf("task")).project.relationTag, "project");
  assert.equal((await fieldsOf("meeting")).projects.relationTag, "project");
  assert.deepEqual((await fieldsOf("meeting")).attendees.relationTarget, { pathPrefix: "vault/people" });
  assert.equal(tagPuts.length, 0, "no vault schema write");
  const writes = fv.calls.slice(before).filter((c: any) => c.method !== "GET");
  assert.deepEqual(writes, [], "no note was written");
  assert.equal(fv.notes.get("t1")!.metadata!.project, "prism", "stored values never change");
  const audit = listActionAudit({ limit: 5 }).find((a) => a.action === "schema.relation-targets");
  assert.ok(audit, "audited");
  assert.doesNotMatch(JSON.stringify(audit), /prism/, "counts only");
});
