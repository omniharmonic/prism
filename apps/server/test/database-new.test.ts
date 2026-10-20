/**
 * "New database" — Blank with schema (`createBlankDatabase`, shared with CSV → new
 * database): the page first, then the tag's properties with `requireNew` (≤ 20 fields per
 * write, the first claims the tag), then the view against the page's CURRENT revision;
 * a refusal before the tag exists takes the page back; a failure keeps its progress and
 * a retry continues without creating anything twice. Plus tag minting and first views.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankDatabaseView,
  blankViewRefusal,
  createBlankDatabase,
  mintNewTag,
  NewDatabaseError,
  newDatabaseSchemaBatches,
  tagFromName,
  viewPropertyKey,
  viewStarterProperty,
  withViewProperty,
  type NewDatabaseProperty,
} from "../../../packages/core/src/components/database/createDatabase";
import { buildNewPropertyPatch } from "../../../packages/core/src/lib/database/schema";
import { readDatabaseConfig } from "../../../packages/core/src/components/database/config";
import type { VaultClient } from "../../../packages/core/src/data/VaultClient";

const prop = (label: string, kind: Parameters<typeof buildNewPropertyPatch>[0]["kind"], extra: Partial<Parameters<typeof buildNewPropertyPatch>[0]> = {}): NewDatabaseProperty => {
  const b = buildNewPropertyPatch({ label, kind, ...extra });
  assert.ok(b.ok);
  return { key: b.key, field: b.patch.fields![b.key]!, ui: b.patch.ui![b.key]! };
};
const STATUS = prop("Status", "status", { options: [{ value: "To do", group: "todo" }, { value: "In progress", group: "in_progress" }, { value: "Done", group: "complete" }] });
const PROJECT = prop("Project", "relation", { target: { tag: "project" } });
const DUE = prop("Due", "date");

/** A fake shell: records every call, enforces CAS on the page and `requireNew` on the tag. */
function fakeClient(opts: { taken?: Set<string>; failSchemaAt?: number; failConfig?: number; failCreate?: boolean } = {}) {
  const log: string[] = [];
  const notes = new Map<string, { id: string; path: string; metadata: Record<string, unknown>; updatedAt: string; tags: string[] }>();
  const schemaWrites: Array<{ tag: string; patch: Record<string, unknown> }> = [];
  let rev = 0;
  let schemaCalls = 0;
  let configFails = opts.failConfig ?? 0;
  const taken = opts.taken ?? new Set<string>();
  const client = {
    createNote: async (p: { path: string; metadata: Record<string, unknown> }) => {
      log.push("create");
      if (opts.failCreate) throw new Error("POST /notes failed: 500");
      const n = { id: `n${notes.size + 1}`, path: p.path, metadata: { ...p.metadata }, updatedAt: `r${++rev}`, tags: [] as string[] };
      notes.set(n.id, n);
      return { ...n };
    },
    getNote: async (id: string) => ({ ...notes.get(id)! }),
    updateNote: async (id: string, p: { metadata: Record<string, unknown>; ifUpdatedAt?: string }) => {
      log.push("config");
      if (configFails > 0) { configFails--; throw new Error("PATCH failed: 502 {\"error\":\"vault_unreachable\"}"); }
      const n = notes.get(id)!;
      if (p.ifUpdatedAt !== n.updatedAt) throw new Error("PATCH failed: 409 conflict");
      Object.assign(n.metadata, p.metadata);
      n.updatedAt = `r${++rev}`;
      return { ...n };
    },
    updateSchema: async (tag: string, patch: Record<string, unknown>) => {
      log.push("schema");
      schemaCalls++;
      if (opts.failSchemaAt === schemaCalls) throw new Error("PUT /schemas failed: 502 {\"error\":\"vault_unreachable\"}");
      if (patch.requireNew && taken.has(tag)) throw new Error(`PUT /schemas failed: 409 {"error":"tag_in_use","detail":"#${tag} is already used by pages"}`);
      taken.add(tag);
      schemaWrites.push({ tag, patch });
      return { description: null, fields: {} };
    },
    trashPage: async (id: string) => { log.push("trash"); notes.get(id)!.tags.push("prism-trashed"); return { rootId: id, trashed: [id] }; },
    checkNewTag: async (tag: string) => (taken.has(tag) ? { tag, available: false, reason: "tag_in_use", detail: `#${tag} is already used by pages` } : { tag, available: true }),
  };
  return { client: client as unknown as VaultClient, log, notes, schemaWrites, taken };
}

test("newDatabaseSchemaBatches: one claim with requireNew; > 20 fields go in batches; no fields = a description claim", () => {
  assert.deepEqual(newDatabaseSchemaBatches({ title: "Empty", properties: [] }), [{ requireNew: true, description: "Pages of the “Empty” database" }]);
  const one = newDatabaseSchemaBatches({ title: "X", properties: [STATUS, PROJECT] });
  assert.equal(one.length, 1);
  assert.equal(one[0]!.requireNew, true);
  assert.deepEqual(Object.keys(one[0]!.fields!), ["status", "project"]);
  assert.equal(one[0]!.ui!.project!.relationTag, "project");
  const many = Array.from({ length: 45 }, (_, i) => prop(`Field ${i}`, "text"));
  const batches = newDatabaseSchemaBatches({ title: "X", properties: many });
  assert.deepEqual(batches.map((b) => Object.keys(b.fields!).length), [20, 20, 5]);
  assert.deepEqual(batches.map((b) => b.requireNew === true), [true, false, false]);
});

test("blankDatabaseView: a board groups by the first status/select, a calendar dates by the first date; else refused", () => {
  assert.deepEqual(blankDatabaseView("table", [STATUS, PROJECT]), { id: "table", name: "Table", type: "table", visible: ["status", "project"] });
  assert.equal(blankDatabaseView("board", [PROJECT, STATUS])!.groupBy, "status");
  assert.equal(blankDatabaseView("calendar", [STATUS, DUE])!.dateKey, "due");
  assert.equal(blankDatabaseView("board", [PROJECT]), null);
  assert.match(blankViewRefusal("board", [PROJECT]), /Status or Select/);
  assert.match(blankViewRefusal("calendar", []), /Date property/);
  assert.equal(blankViewRefusal("gallery", []), "");
  // Every first view is a config the renderer accepts.
  for (const t of ["table", "board", "gallery", "list", "calendar"] as const) {
    const v = blankDatabaseView(t, [STATUS, PROJECT, DUE])!;
    assert.ok(readDatabaseConfig({ prism_type: "database", prism_database: { version: 1, source: { tags: ["x"] }, views: [v] } }), t);
  }
});

test("withViewProperty: a board / calendar that nothing serves gets a Status / Date ADDED; others need nothing", () => {
  const board = withViewProperty("board", [PROJECT]);
  assert.equal(board.added!.key, "status");
  assert.deepEqual(board.added!.field, { type: "string", enum: ["To do", "In progress", "Done"] });
  assert.equal(board.added!.ui.kind, "status");
  assert.deepEqual(board.properties.map((p) => p.key), ["project", "status"]);
  assert.equal(blankDatabaseView("board", board.properties)!.groupBy, "status");
  const cal = withViewProperty("calendar", [STATUS]);
  assert.deepEqual(cal.added && { key: cal.added.key, field: cal.added.field, kind: cal.added.ui.kind, label: cal.added.ui.label }, { key: "date", field: { type: "date" }, kind: "date", label: "Date" });
  assert.equal(viewPropertyKey("calendar", cal.properties), "date");
  // Served already → nothing added; tables etc. never get one.
  assert.equal(withViewProperty("board", [STATUS]).added, null);
  assert.equal(withViewProperty("calendar", [DUE]).added, null);
  for (const t of ["table", "gallery", "list"] as const) assert.equal(viewStarterProperty(t, []), null);
  // A key already taken by another kind ("Date" as text) → "Date 2".
  const text = prop("Date", "text");
  assert.equal(viewStarterProperty("calendar", [text])!.key, "date_2");
});

test("createBlankDatabase: page → schema (requireNew) → view on the page's current revision", async () => {
  const fx = fakeClient();
  const view = blankDatabaseView("board", [STATUS, PROJECT, DUE])!;
  const out = await createBlankDatabase(fx.client, { tag: "reading-list", title: "Reading list", folder: "Projects/", properties: [STATUS, PROJECT, DUE], view });
  assert.deepEqual(fx.log, ["create", "schema", "config"]);
  assert.equal(out.note.path, "Projects/Reading list");
  assert.deepEqual(out.progress, { note: out.note, createdPage: true, schemaBatches: 1, schemaDone: true, configDone: true });
  assert.equal(fx.schemaWrites[0]!.tag, "reading-list");
  assert.equal(fx.schemaWrites[0]!.patch.requireNew, true);
  const page = fx.notes.get(out.note.id)!;
  assert.deepEqual(page.metadata.prism_database, { version: 1, source: { tags: ["reading-list"] }, views: [view] });
  assert.equal(page.metadata.prism_type, "database");
});

test("createBlankDatabase: a refused tag takes the page back; nothing of the tag exists", async () => {
  const fx = fakeClient({ taken: new Set(["book"]) });
  await assert.rejects(createBlankDatabase(fx.client, { tag: "book", title: "Books", properties: [STATUS] }), (e: unknown) => {
    assert.ok(e instanceof NewDatabaseError);
    assert.equal(e.stage, "schema");
    assert.equal(e.pageRemoved, true);
    assert.equal(e.detail, "#book is already used by pages");
    assert.equal(e.progress.note, undefined);
    return true;
  });
  assert.deepEqual(fx.log, ["create", "schema", "trash"]);
  assert.equal(fx.schemaWrites.length, 0);
});

test("createBlankDatabase: resume after a failed view write re-uses the page and the schema", async () => {
  const fx = fakeClient({ failConfig: 1 });
  const plan = { tag: "crm", title: "CRM", properties: [STATUS, PROJECT] };
  let progress;
  try {
    await createBlankDatabase(fx.client, plan);
    assert.fail("should have failed");
  } catch (e) {
    assert.ok(e instanceof NewDatabaseError);
    assert.equal(e.stage, "config");
    progress = e.progress;
  }
  assert.equal(progress.schemaDone, true);
  // The page changed meanwhile (an icon was set): the retry reads its revision again.
  const page = fx.notes.get(progress.note!.id)!;
  page.metadata.icon = "📇";
  page.updatedAt = "r-elsewhere";
  const out = await createBlankDatabase(fx.client, plan, progress);
  assert.deepEqual(fx.log, ["create", "schema", "config", "config"]);
  assert.equal(out.note.id, progress.note!.id);
  assert.equal(page.metadata.icon, "📇");
  assert.ok(readDatabaseConfig(page.metadata));
});

test("createBlankDatabase: a failure after some property batches resumes at the next batch, never re-claims", async () => {
  const fx = fakeClient({ failSchemaAt: 2 });
  const many = Array.from({ length: 30 }, (_, i) => prop(`Field ${i}`, "text"));
  const plan = { tag: "wide", title: "Wide", properties: many };
  let progress;
  try { await createBlankDatabase(fx.client, plan); assert.fail("should have failed"); } catch (e) {
    assert.ok(e instanceof NewDatabaseError);
    assert.equal(e.stage, "schema");
    assert.equal(e.pageRemoved, false); // the tag is claimed: the page stays
    progress = e.progress;
  }
  assert.equal(progress.schemaBatches, 1);
  await createBlankDatabase(fx.client, plan, progress);
  assert.deepEqual(fx.schemaWrites.map((w) => [Object.keys(w.patch.fields as object).length, w.patch.requireNew === true]), [[20, true], [10, false]]);
  assert.deepEqual(fx.log.filter((x) => x === "create").length, 1);
});

test("createBlankDatabase: a page that could not be made leaves nothing", async () => {
  const fx = fakeClient({ failCreate: true });
  await assert.rejects(createBlankDatabase(fx.client, { tag: "t", title: "T", properties: [] }), (e: unknown) => e instanceof NewDatabaseError && e.stage === "page");
  assert.deepEqual(fx.log, ["create"]);
});

test("tags: minted from the name and made unique through the server's availability", async () => {
  assert.equal(tagFromName("Reading list"), "reading-list");
  assert.equal(tagFromName("  Café — Ideas!! "), "cafe-ideas");
  assert.equal(tagFromName("***"), "database");
  const fx = fakeClient({ taken: new Set(["projects", "projects-2"]) });
  assert.deepEqual(await mintNewTag(fx.client, "projects"), { tag: "projects-3" });
  assert.deepEqual(await mintNewTag(fx.client, "fresh"), { tag: "fresh" });
  const refused = await mintNewTag(fx.client, "projects", 2);
  assert.equal(refused.tag, null);
});
