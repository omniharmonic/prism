/**
 * Isolated database views + typed page properties, fictional data, no network.
 * The VaultClient below implements the server seam (`getSchemas`, `queryNotes`,
 * `updateProperties`, `updateSchema`) with the SAME pure engine the server uses
 * (`@prism/core/database`), so filtering/sorting/paging here is the real code.
 *
 *   ?open=<id>   open that note (default: the database page)
 *   ?legacy      a shell without the server routes (bundled schemas + listNotes)
 *   ?viewer      non-owner: rows carry `_caps: ["view"]`, one private row hidden
 *   ?dark        dark theme
 *   ?block       a page holding inline/linked database blocks (renderDatabaseBlock)
 *   ?templates   the database starts with a "Bug report" template
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, CollabDocumentProvider, PlatformProvider, useUIStore, useAgentChatStore, PropertyConflictError, VaultRequestError, renderDatabaseBlock, parseDatabaseBlock, databaseBlockHtml, type VaultClient, type Note } from "@prism/core";
import { Canvas } from "../../../packages/core/src/components/layout/Canvas";
import { applyTheme } from "../../../packages/core/src/app/stores/settings";
import { coerceCsvValue, mergeSchemaFields, parseCsv, runQuery, type CsvImportRequest, type CsvImportResponse, type CsvImportRow, type PropertyBatchResult, type QuerySpec, type SchemaMap, type SchemaPatch } from "@prism/core/database";

const params = new URLSearchParams(location.search);
applyTheme(params.has("dark") ? "dark" : "light");
const viewer = params.has("viewer");
const link = params.has("link");
const legacy = params.has("legacy");
useAgentChatStore.setState({ scope: "db-fixture" });

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const at = "2026-10-01T12:00:00.000Z";
let rev = 0;
const task = (id: string, title: string, meta: Record<string, unknown>, extra: Partial<Note> = {}): Note => ({
  id, path: `Projects/Launch plan/${title}`, content: `<p>${title} — fictional task.</p>`, tags: ["task"],
  metadata: { title, ...meta }, createdAt: at, updatedAt: at, ...extra,
});

const schemas: SchemaMap = {
  task: {
    description: "Work to be done",
    fields: {
      status: { type: "string", enum: ["todo", "in-progress", "done"], default: "todo", colors: { "in-progress": "blue" } },
      priority: { type: "string", enum: ["low", "medium", "high"], colors: { blocked: "red" } },
      due: { type: "string" },
      estimate: { type: "number", label: "Estimate (h)" },
      assignee: { type: "string" },
      project: { type: "string", kind: "relation", relationTag: "initiative", reverseLabel: "Tasks" },
      email: { type: "string" },
      phone: { type: "string" },
      link: { type: "string" },
      flagged: { type: "boolean" },
      labels: { type: "array", colors: { design: "purple", launch: "orange" } },
    },
  },
  person: { description: "People", fields: { role: { type: "string" } } },
  initiative: { description: "Initiatives", fields: { stage: { type: "string" } } },
};

let notes: Note[] = [
  {
    id: "db", path: "Projects/Launch plan", content: "<p>Plan and ship the next release. Keep tasks focused, visible and moving.</p>", tags: [],
    metadata: {
      prism_type: "database", title: "Launch plan",
      prism_database: {
        version: 1, source: { tags: ["task"] },
        views: [
          { id: "table", name: "All tasks", type: "table", visible: ["status", "priority", "due", "assignee", "estimate", "labels", "flagged", "link"] },
          { id: "board", name: "Board", type: "board", groupBy: "status", visible: ["priority", "due", "assignee"] },
          { id: "gallery", name: "Gallery", type: "gallery", visible: ["status", "priority"] },
          { id: "list", name: "List", type: "list", visible: ["status", "due"] },
          { id: "calendar", name: "Calendar", type: "calendar", dateKey: "due" },
        ],
      },
    },
    createdAt: at, updatedAt: at,
  },
  task("t1", "Review workspace navigation", { status: "todo", priority: "high", due: day(2), estimate: 3, assignee: "[[People/Mira Chen]]", labels: ["design"], flagged: true, link: "https://example.test/nav", project: "[[Projects/Atlas]]", prism_creator: "mira@example.test", prism_last_writer: "sam@example.test" }, { createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-30T16:00:00.000Z" }),
  task("t2", "Write release notes", { status: "in-progress", priority: "high", due: day(4), estimate: 2, assignee: "[[People/Sam Rivera]]", labels: ["launch"], project: "[[Projects/Atlas]]", notes: "Mention the printer driver fix", prism_creator: "sam@example.test", prism_last_writer: "mira@example.test" }, { createdAt: "2026-09-25T09:00:00.000Z" }),
  task("t3", "Refine onboarding copy", { status: "in-progress", priority: "medium", due: day(8), estimate: 5 }),
  task("t4", "Design new icon set", { status: "done", priority: "medium", due: day(-3), labels: ["design"], icon: "🎨" }),
  task("t5", "Update pricing page", { status: "done", priority: "low", due: day(-1) }),
  task("t6", "Private planning note", { status: "todo", priority: "low", prism_visibility: "private" }, { id: "t6" }),
  { id: "p1", path: "People/Mira Chen", content: "", tags: ["person"], metadata: { title: "Mira Chen", role: "Design" }, createdAt: at, updatedAt: at },
  { id: "p2", path: "People/Sam Rivera", content: "", tags: ["person"], metadata: { title: "Sam Rivera", role: "Engineering" }, createdAt: at, updatedAt: at },
  { id: "atlas", path: "Projects/Atlas", content: "<p>Atlas initiative.</p>", tags: ["initiative"], metadata: { title: "Atlas", stage: "active" }, createdAt: at, updatedAt: at },
  { id: "beacon", path: "Projects/Beacon", content: "<p>Beacon initiative.</p>", tags: ["initiative"], metadata: { title: "Beacon", stage: "planning" }, createdAt: at, updatedAt: at },
  { id: "tpl-bug", path: "Projects/Launch plan/Templates/Bug report", content: "<h2>Steps to reproduce</h2><p>1.</p>", tags: [], metadata: { title: "Bug report", prism_template_for: "db", prism_template_props: { priority: "high", labels: ["bug"] } }, createdAt: at, updatedAt: at },
  { id: "page", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A single, evolving place for thinking and projects.</p>", tags: ["task", "research"], metadata: { title: "A living workspace", status: "in-progress", priority: "medium", owner: "Alex Chen" }, createdAt: at, updatedAt: at },
];
// Survive a reload within one test (sessionStorage is per page/tab).
const persisted = sessionStorage.getItem("db-fixture-notes");
if (persisted) notes = JSON.parse(persisted);
const save = () => sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
if (params.has("templates") && !persisted) {
  const db = notes.find((n) => n.id === "db")!;
  db.metadata = { ...db.metadata, prism_database: { ...(db.metadata!.prism_database as object), templates: [{ id: "tpl-bug", name: "Bug report" }] } };
}
if (params.has("tz")) notes.push(task("t7", "Late call", { status: "todo", due: `${day(3)}T05:00:00Z` }));
if (link) notes = notes.map((n) => ({ ...n, _level: "view" }));
if (viewer) notes = notes.map((n) => (n.id === "t6" ? n : { ...n, _caps: ["view"] }));

const controls = {
  writes: [] as unknown[],
  creates: [] as unknown[],
  schemaWrites: [] as unknown[],
  failNext: false,
  /** The next property write finds the field already changed to this value elsewhere. */
  conflictWith: undefined as unknown,
  slowMs: 0,
  listCalls: 0,
  queries: [] as QuerySpec[],
  notes: () => notes,
  trashed: [] as string[],
  restored: [] as string[],
  batches: [] as unknown[],
  imports: [] as unknown[],
};
Object.assign(window, { dbFixture: controls, prismUI: useUIStore });

const clone = <T,>(v: T): T => structuredClone(v);
const find = (id: string) => notes.find((n) => n.id === id || n.path === id);
const visible = () => notes.filter((n) => !(viewer && n.metadata?.prism_visibility === "private") && !(n.tags ?? []).includes("prism-trashed"));
let rev0 = Number(sessionStorage.getItem("db-fixture-rev") ?? 0);
const bump = (n: Note) => { rev0 += 1; n.updatedAt = `2026-10-02T00:${String(Math.floor(rev0 / 60)).padStart(2, "0")}:${String(rev0 % 60).padStart(2, "0")}.000Z`; sessionStorage.setItem("db-fixture-rev", String(rev0)); save(); };

const client: Partial<VaultClient> = {
  scope: () => "db-fixture",
  listNotes: async (f) => (controls.listCalls++, clone(visible().filter((n) => !f?.tag || n.tags?.includes(f.tag)).slice(0, f?.limit ?? 50000))),
  listTree: async () => clone(visible()),
  getNote: async (id) => {
    const n = find(id);
    if (!n) throw new Error("GET /notes failed: 404");
    return clone(n);
  },
  search: async (q, tags) => clone(visible().filter((n) => (!tags?.length || tags.every((t) => n.tags?.includes(t))) && JSON.stringify(n.metadata).toLowerCase().includes(q.toLowerCase()))),
  getTags: async () => [{ tag: "task", count: 7 }, { tag: "person", count: 2 }, { tag: "research", count: 1 }, { tag: "writing", count: 4 }, { tag: "planning", count: 3 }],
  addTags: async (id, tags) => { const n = find(id)!; n.tags = [...new Set([...(n.tags ?? []), ...tags])]; bump(n); },
  removeTags: async (id, tags) => { const n = find(id)!; n.tags = (n.tags ?? []).filter((t) => !tags.includes(t)); bump(n); },
  getLinks: async () => [],
  getStats: async () => ({ totalNotes: notes.length, totalTags: 5, totalLinks: 0 }) as never,
  getVaultInfo: async () => ({ name: "Fixture", description: "", stats: {} }) as never,
  getGraph: async () => ({ nodes: [], edges: [] }),
  createNote: async (p) => {
    controls.creates.push(clone(p));
    if (controls.failNext) { controls.failNext = false; throw new Error("The page could not be created. Your title is kept; try again."); }
    const n: Note = { id: `new-${++rev}`, content: p.content, path: p.path ?? null, tags: p.tags ?? [], metadata: p.metadata ?? {}, createdAt: at, updatedAt: at, ...(viewer ? { _caps: ["view", "edit"] } : {}) };
    notes.push(n);
    save();
    return clone(n);
  },
  updateNote: async (id, p) => {
    controls.writes.push(clone({ id, ...p }));
    if (controls.slowMs) await new Promise((r) => setTimeout(r, controls.slowMs));
    const n = find(id)!;
    if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== n.updatedAt) throw new Error("PATCH failed: 409 conflict");
    if (p.metadata) {
      const meta = { ...(n.metadata ?? {}) };
      for (const [k, v] of Object.entries(p.metadata)) if (v === null) delete meta[k]; else meta[k] = v;
      n.metadata = meta;
    }
    if (p.path) n.path = p.path;
    if (p.content !== undefined) n.content = p.content;
    bump(n);
    return clone(n);
  },
};

if (!legacy) {
  client.getSchemas = async () => ({ schemas: clone(schemas), canEdit: !viewer && !link });
  client.updateSchema = async (tag: string, patch: SchemaPatch) => {
    controls.schemaWrites.push(clone({ tag, patch }));
    const cur = schemas[tag] ?? { description: null, fields: {} };
    const merged = mergeSchemaFields(cur.fields, patch.fields ?? {});
    if (!merged.ok) throw new Error(merged.error);
    for (const [k, h] of Object.entries(patch.ui ?? {})) merged.fields[k] = { ...(merged.fields[k] ?? {}), ...h };
    schemas[tag] = { description: patch.description ?? cur.description, fields: merged.fields };
    return clone(schemas[tag]!);
  };
  client.queryNotes = async (spec: QuerySpec) => {
    controls.queries.push(clone(spec));
    if (params.has("forbidden")) throw new VaultRequestError(403, "POST /query failed: 403 forbidden");
    const rows = visible().map((n) => ({ ...n, content: "", canEdit: !link && (!viewer || !!n._caps?.includes("edit")) }));
    return runQuery(rows, spec, { limited: viewer || link });
  };
  client.updateProperties = async (id, set, expect) => {
    controls.writes.push(clone({ id, set, expect }));
    const n = find(id)!;
    if (viewer && !n._caps?.includes("edit")) throw new Error("You can only view this page.");
    if (controls.failNext) { controls.failNext = false; throw new Error("POST /properties failed: 503"); }
    if (controls.conflictWith !== undefined) {
      const key = Object.keys(set)[0]!;
      n.metadata = { ...(n.metadata ?? {}), [key]: controls.conflictWith };
      controls.conflictWith = undefined;
      bump(n);
    }
    const stale = Object.entries(expect ?? {}).filter(([k, v]) => JSON.stringify(n.metadata?.[k] ?? null) !== JSON.stringify(v ?? null));
    if (stale.length) throw new PropertyConflictError(stale.map(([k]) => k), Object.fromEntries(stale.map(([k]) => [k, n.metadata?.[k] ?? null])));
    const meta = { ...(n.metadata ?? {}) };
    for (const [k, v] of Object.entries(set)) if (v === null) delete meta[k]; else meta[k] = v;
    n.metadata = meta;
    bump(n);
    return { id: n.id, updatedAt: n.updatedAt, metadata: clone(meta) };
  };
}

client.trashPage = async (id) => {
  const n = find(id)!;
  if (viewer && !n._caps?.includes("edit")) throw new Error("POST /notes/x/trash failed: 403");
  n.tags = [...(n.tags ?? []), "prism-trashed"];
  bump(n);
  controls.trashed.push(id);
  return { rootId: id, trashed: [id] };
};
client.restoreFromTrash = async (id) => {
  const n = find(id)!;
  n.tags = (n.tags ?? []).filter((t) => t !== "prism-trashed");
  bump(n);
  controls.restored.push(id);
  return { restored: [id] };
};
if (!legacy) {
  client.updatePropertiesBatch = async (items) => {
    controls.batches.push(clone(items));
    const out: PropertyBatchResult[] = [];
    for (const it of items) {
      try {
        const r = await client.updateProperties!(it.id, it.set, it.expect);
        out.push({ id: it.id, ok: true, updatedAt: r.updatedAt, metadata: r.metadata });
      } catch (e) {
        out.push(e instanceof PropertyConflictError ? { id: it.id, ok: false, error: "conflict", fields: e.fields, current: e.current } : { id: it.id, ok: false, error: "forbidden" });
      }
    }
    return out;
  };
  // A compact emulation of POST /api/databases/import/csv (the real one is server-tested).
  client.importCsv = async (req: CsvImportRequest): Promise<CsvImportResponse> => {
    controls.imports.push(clone({ ...req, csv: req.csv.length }));
    const [header, ...rows] = parseCsv(req.csv);
    const fields = schemas[req.tag]?.fields ?? {};
    const keyCol = req.keyColumn ?? Object.entries(req.mapping).find(([, k]) => k === "$title")![0];
    const keyProp = req.mapping[keyCol]!;
    const existing = visible().filter((n) => n.tags?.includes(req.tag));
    const keyOf = (v: unknown) => String(v ?? "").trim().toLowerCase();
    const plans: Array<CsvImportRow & { set?: Record<string, unknown> }> = [];
    rows.forEach((cells, i) => {
      const values: Record<string, unknown> = {};
      let title = "";
      let error = "";
      for (const [col, key] of Object.entries(req.mapping)) {
        if (!key) continue;
        const raw = cells[header!.indexOf(col)] ?? "";
        if (key === "$title") { title = raw.trim(); continue; }
        const c = coerceCsvValue(raw, fields[key]);
        if ("error" in c) { error = `${col}: ${c.error}`; break; }
        values[key] = c.value;
      }
      if (error) return void plans.push({ row: i + 2, action: "error", title, error });
      const k = keyOf(keyProp === "$title" ? title : values[keyProp]);
      const match = existing.find((n) => keyOf(keyProp === "$title" ? n.metadata?.title : n.metadata?.[keyProp]) === k);
      if (match) {
        const set: Record<string, unknown> = {};
        for (const [kk, v] of Object.entries({ title, ...values })) if (JSON.stringify(match.metadata?.[kk] ?? null) !== JSON.stringify(v ?? null)) set[kk] = v;
        plans.push({ row: i + 2, action: Object.keys(set).length ? "update" : "unchanged", title, id: match.id, changes: Object.keys(set), set });
      } else plans.push({ row: i + 2, action: "create", title, changes: Object.keys(values), set: { title, ...values } });
    });
    const count = (a: string) => plans.filter((p) => p.action === a).length;
    const res: CsvImportResponse = {
      dryRun: req.dryRun !== false, tag: req.tag, rows: rows.length, key: keyCol,
      summary: { create: count("create"), update: count("update"), unchanged: count("unchanged"), error: count("error") },
      sample: plans.filter((p) => p.action !== "error").map(({ set: _s, ...p }) => p),
      errors: plans.filter((p) => p.action === "error").map(({ set: _s, ...p }) => p),
    };
    if (req.dryRun === false) {
      let created = 0, updated = 0;
      for (const p of plans) {
        if (p.action === "create") { await client.createNote!({ content: "", path: `${req.pathPrefix}/${p.title}`, tags: [req.tag], metadata: p.set }); created++; }
        if (p.action === "update") { const n = find(p.id!)!; n.metadata = { ...n.metadata, ...p.set }; bump(n); updated++; }
      }
      res.result = { created, updated, failed: [] };
    }
    return res;
  };
}

const open = params.get("open") ?? "db";
const target = find(open)!;
useUIStore.getState().openTab(target.id, target.metadata?.title as string, target.id === "db" ? "database" : "task");
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <PlatformProvider value="web">
        <VaultClientProvider client={client as VaultClient}>
          <CollabDocumentProvider value={{ useLiveCollab: () => false, CollabDocument: () => null }}>
            {params.has("block") ? (
              <main style={{ height: "100dvh", overflow: "auto", padding: "32px clamp(16px, 5vw, 64px)", background: "var(--bg-document, var(--bg-base))", color: "var(--text-primary)" }}>
                <article aria-label="Launch brief" style={{ maxWidth: 1100, margin: "0 auto" }}>
                  <h1>Launch brief</h1>
                  <p>The board below is a linked view of the Launch plan database.</p>
                  {(() => {
                    // Exactly what the editor stores and parses for the databaseView atom.
                    const el = document.createElement("div");
                    el.innerHTML = databaseBlockHtml("db", "board");
                    const attrs = parseDatabaseBlock(el.firstElementChild!)!;
                    return renderDatabaseBlock(attrs.noteId, attrs.viewId);
                  })()}
                  <p>And every task as a table:</p>
                  {renderDatabaseBlock("db", "table")}
                  {renderDatabaseBlock("nope-404")}
                </article>
              </main>
            ) : (
              <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><Canvas /></main>
            )}
          </CollabDocumentProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
