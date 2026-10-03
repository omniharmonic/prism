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
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, CollabDocumentProvider, PlatformProvider, useUIStore, useAgentChatStore, PropertyConflictError, type VaultClient, type Note } from "@prism/core";
import { Canvas } from "../../../packages/core/src/components/layout/Canvas";
import { applyTheme } from "../../../packages/core/src/app/stores/settings";
import { mergeSchemaFields, runQuery, type QuerySpec, type SchemaMap, type SchemaPatch } from "@prism/core/database";

const params = new URLSearchParams(location.search);
applyTheme(params.has("dark") ? "dark" : "light");
const viewer = params.has("viewer");
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
      priority: { type: "string", enum: ["low", "medium", "high"] },
      due: { type: "string" },
      estimate: { type: "number", label: "Estimate (h)" },
      assignee: { type: "string" },
      project: { type: "string", kind: "relation" },
      link: { type: "string" },
      flagged: { type: "boolean" },
      labels: { type: "array", colors: { design: "purple", launch: "orange" } },
    },
  },
  person: { description: "People", fields: { role: { type: "string" } } },
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
  task("t1", "Review workspace navigation", { status: "todo", priority: "high", due: day(2), estimate: 3, assignee: "[[People/Mira Chen]]", labels: ["design"], flagged: true, link: "https://example.test/nav" }),
  task("t2", "Write release notes", { status: "in-progress", priority: "high", due: day(4), estimate: 2, assignee: "[[People/Sam Rivera]]", labels: ["launch"] }),
  task("t3", "Refine onboarding copy", { status: "in-progress", priority: "medium", due: day(8), estimate: 5 }),
  task("t4", "Design new icon set", { status: "done", priority: "medium", due: day(-3), labels: ["design"], icon: "🎨" }),
  task("t5", "Update pricing page", { status: "done", priority: "low", due: day(-1) }),
  task("t6", "Private planning note", { status: "todo", priority: "low", prism_visibility: "private" }, { id: "t6" }),
  { id: "p1", path: "People/Mira Chen", content: "", tags: ["person"], metadata: { title: "Mira Chen", role: "Design" }, createdAt: at, updatedAt: at },
  { id: "p2", path: "People/Sam Rivera", content: "", tags: ["person"], metadata: { title: "Sam Rivera", role: "Engineering" }, createdAt: at, updatedAt: at },
  { id: "page", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A single, evolving place for thinking and projects.</p>", tags: ["task", "research"], metadata: { title: "A living workspace", status: "in-progress", priority: "medium", owner: "Alex Chen" }, createdAt: at, updatedAt: at },
];
// Survive a reload within one test (sessionStorage is per page/tab).
const persisted = sessionStorage.getItem("db-fixture-notes");
if (persisted) notes = JSON.parse(persisted);
const save = () => sessionStorage.setItem("db-fixture-notes", JSON.stringify(notes));
if (viewer) notes = notes.map((n) => (n.id === "t6" ? n : { ...n, _caps: ["view"] }));

const controls = {
  writes: [] as unknown[],
  creates: [] as unknown[],
  schemaWrites: [] as unknown[],
  failNext: false,
  /** The next property write finds the field already changed to this value elsewhere. */
  conflictWith: undefined as unknown,
  notes: () => notes,
};
Object.assign(window, { dbFixture: controls, prismUI: useUIStore });

const clone = <T,>(v: T): T => structuredClone(v);
const find = (id: string) => notes.find((n) => n.id === id || n.path === id);
const visible = () => notes.filter((n) => !(viewer && n.metadata?.prism_visibility === "private"));
let rev0 = Number(sessionStorage.getItem("db-fixture-rev") ?? 0);
const bump = (n: Note) => { rev0 += 1; n.updatedAt = `2026-10-02T00:${String(Math.floor(rev0 / 60)).padStart(2, "0")}:${String(rev0 % 60).padStart(2, "0")}.000Z`; sessionStorage.setItem("db-fixture-rev", String(rev0)); save(); };

const client: Partial<VaultClient> = {
  scope: () => "db-fixture",
  listNotes: async (f) => clone(visible().filter((n) => !f?.tag || n.tags?.includes(f.tag)).slice(0, f?.limit ?? 50000)),
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
  client.getSchemas = async () => clone(schemas);
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
    const rows = visible().map((n) => ({ ...n, content: "" }));
    return runQuery(rows, spec, { limited: viewer });
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
            <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><Canvas /></main>
          </CollabDocumentProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
