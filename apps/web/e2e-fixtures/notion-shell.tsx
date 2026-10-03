/**
 * Wave 2E shell fixture: the real App + HttpVaultClient (outbox, read cache,
 * sync state) over an intercepted fetch with fictional notes. Controls on
 * `window.prismShell` hold, fail or count writes and searches.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App, CollabSharingProvider, PlatformProvider, VaultClientProvider, useUIStore, type Note } from "@prism/core";
import { filtersToParams, matchesFilters, parseSearchFilters, queryTerms, searchMatches } from "@prism/core/search";
import { inferContentType } from "../../../packages/core/src/lib/schemas/content-types";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";
import { OfflineIndicator } from "../src/offline/OfflineIndicator";
import { startOutboxSync } from "../src/offline/outbox";

void filtersToParams;
const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const recent = "2026-10-01T12:00:00.000Z";
const notes: Note[] = [
  { id: "workspace", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A shared place to think, write and plan the workshop together.</p>", tags: ["note"], metadata: { type: "document", prism_creator: "owner@example.test" }, createdAt: "2026-09-01T09:00:00.000Z", updatedAt: recent },
  { id: "agenda", path: "Library/Workshop agenda", content: "<p>Saturday: opening discussion, field notes, next steps for the workshop.</p>", tags: ["note"], metadata: { type: "document", prism_creator: "mira@example.test" }, createdAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-02T09:00:00.000Z" },
  { id: "tracker", path: "Projects/Prism/Workshop tracker", content: "", tags: ["task"], metadata: { prism_type: "database", prism_creator: "owner@example.test" }, createdAt: recent, updatedAt: recent },
  { id: "field-notes", path: "Journal/Field notes", content: "<p>Notes from the last conversation about the workshop budget. See A living workspace for the plan.</p>", tags: ["note"], metadata: { type: "document", prism_creator: "owner@example.test" }, createdAt: recent, updatedAt: recent },
  { id: "blank", path: "Projects/Prism/Untitled", content: "", tags: [], metadata: { type: "document" }, createdAt: recent, updatedAt: recent },
  { id: "tpl", path: "Templates/Meeting notes", content: "<h2>Agenda</h2><p>Topics to cover.</p>", tags: ["template"], metadata: { type: "document" }, createdAt: recent, updatedAt: recent },
];
// Metadata written by the app survives reloads ("another device" = a fresh page).
const savedMeta = JSON.parse(sessionStorage.getItem("notion-shell-meta") ?? "{}") as Record<string, Record<string, unknown>>;
for (const n of notes) if (savedMeta[n.id]) n.metadata = { ...n.metadata, ...savedMeta[n.id] };
const persistMeta = (n: Note) => { savedMeta[n.id] = { ...(n.metadata ?? {}) }; sessionStorage.setItem("notion-shell-meta", JSON.stringify(savedMeta)); };
const controls = {
  writes: [] as Array<{ method: string; path: string; body: unknown }>,
  searches: [] as string[],
  hold: false,
  release: [] as Array<() => void>,
  failStatus: 0,
  preferences: { favorites: params.has("favorites") ? ["agenda"] : [] as string[], recents: [] as string[] },
  revision: 1,
  reads: [] as string[],
  actor: "owner@example.test",
  signedOut: false,
  /** Pages this account can no longer see (absent from the tree, 403 on read). */
  hidden: [] as string[],
  refreshMe: () => fetchMe(),
  /** Another device/agent changed the page on the server. */
  serverEdit: (id: string, content: string) => { const n = notes.find((x) => x.id === id)!; n.content = content; n.updatedAt = bump(); },
  note: (id: string) => notes.find((x) => x.id === id),
  switchActor: async (email: string) => { controls.actor = email; await fetchMe(); },
};
let seq = 0;
let createdSeq = 0;
const bump = () => `2026-10-02T00:${String(Math.floor(++seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`;
Object.assign(window, { prismShell: controls, prismShellUI: useUIStore, prismShellClient: httpVaultClient });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (!navigator.onLine && (path.startsWith("/api/") || path.startsWith("/auth/"))) throw new TypeError("Failed to fetch");
  if (path === "/auth/me" && controls.signedOut) return Response.json({ authenticated: false });
  if (path === "/auth/me") return Response.json({ authenticated: true, email: controls.actor, name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/me/preferences") {
    if (method === "PUT") { const body = JSON.parse(String(init?.body)); controls.preferences = { ...controls.preferences, ...body.preferences }; controls.revision++; }
    const items = Object.fromEntries(notes.map((n) => [n.id, { path: n.path, title: n.path!.split("/").pop()!, tags: n.tags ?? [], type: n.metadata?.type as string | undefined }]));
    return Response.json({ preferences: { version: 1, favorites: controls.preferences.favorites, recents: controls.preferences.recents, sidebar: { order: [], collapsed: [] } }, revision: controls.revision, items });
  }
  if (path === "/api/tree") return Response.json(notes.filter((n) => !controls.hidden.includes(n.id)).map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, prismType: n.metadata?.prism_type })));
  if (path === "/api/search") {
    controls.searches.push(url.search);
    const q = url.searchParams.get("q") ?? "";
    const terms = queryTerms(q);
    const f = parseSearchFilters((k) => url.searchParams.get(k) ?? undefined);
    if (f.author === "me") f.author = "owner@example.test";
    const hits = notes.filter((n) => terms.every((t) => (n.path + " " + n.content).toLowerCase().includes(t)))
      .filter((n) => matchesFilters(n, f, terms, (x) => inferContentType(x as Note)))
      .map((n) => ({ ...n, content: undefined, _matches: searchMatches(n, terms) }));
    return Response.json(hits);
  }
  if (path === "/api/search/semantic") return Response.json({ error: "semantic_index_primary_only" }, { status: 409 });
  if (path === "/api/notes" && method === "GET") return Response.json(notes.filter((n) => !url.searchParams.has("search") || (n.content ?? "").includes(url.searchParams.get("search")!)));
  const metaId = path.match(/^\/api\/notes\/([^/]+)\/meta$/)?.[1];
  if (metaId && method === "POST") {
    const note = notes.find((n) => n.id === decodeURIComponent(metaId));
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    const body = JSON.parse(String(init?.body));
    controls.writes.push({ method, path, body });
    if (body.if_updated_at !== note.updatedAt) return Response.json({ error: "conflict" }, { status: 409 });
    note.metadata = { ...note.metadata, ...body.set };
    note.updatedAt = bump();
    persistMeta(note);
    return Response.json({ ok: true, id: note.id, updatedAt: note.updatedAt, metadata: body.set });
  }
  const propsId = path.match(/^\/api\/properties\/([^/]+)$/)?.[1];
  if (propsId && method === "POST") {
    const note = notes.find((n) => n.id === decodeURIComponent(propsId));
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    const body = JSON.parse(String(init?.body));
    controls.writes.push({ method, path, body });
    note.metadata = { ...note.metadata, ...body.set };
    note.updatedAt = bump();
    persistMeta(note);
    return Response.json({ id: note.id, updatedAt: note.updatedAt, metadata: note.metadata });
  }
  if (path === "/api/notes" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    controls.writes.push({ method, path, body });
    const created: Note = { id: `created-${++createdSeq}`, content: " ", metadata: {}, tags: [], ...body, createdAt: bump(), updatedAt: bump() };
    notes.push(created);
    return Response.json(created);
  }
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    const note = notes.find((n) => n.id === decodeURIComponent(noteId));
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (controls.hidden.includes(note.id)) return Response.json({ error: "forbidden" }, { status: 403 });
    if (method === "GET") controls.reads.push(note.id);
    if (method === "DELETE") { controls.writes.push({ method, path, body: null }); notes.splice(notes.indexOf(note), 1); return Response.json({ ok: true }); }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      controls.writes.push({ method, path, body });
      if (controls.hold) await new Promise<void>((resolve) => controls.release.push(resolve));
      if (controls.failStatus) return Response.json({ error: "fixture_failure" }, { status: controls.failStatus });
      // The vault's contract: a content/metadata/path write names its base revision or says `force`.
      const guarded = ["content", "metadata", "path"].some((k) => k in body);
      if (guarded && !body.force && !body.if_updated_at) return Response.json({ error: "precondition_required" }, { status: 428 });
      if (body.if_updated_at && body.if_updated_at !== note.updatedAt) return Response.json({ error: "conflict", current: { updatedAt: note.updatedAt } }, { status: 409 });
      const { if_updated_at: _base, force: _force, ...fields } = body;
      Object.assign(note, fields, { metadata: { ...note.metadata, ...body.metadata }, updatedAt: bump() });
      if (body.metadata) persistMeta(note);
    }
    if (url.searchParams.get("include_links") === "true") {
      // Two visible pages and one the viewer can't see (absent from /api/tree) link here.
      const links = note.id === "workspace" ? [
        { sourceId: "agenda", targetId: "workspace", relationship: "wikilink" },
        { sourceId: "field-notes", targetId: "workspace", relationship: "references" },
        { sourceId: "hidden-page", targetId: "workspace", relationship: "wikilink" },
        { sourceId: "workspace", targetId: "agenda", relationship: "wikilink" },
      ] : [];
      return Response.json({ ...note, links });
    }
    return Response.json(note);
  }
  if (params.has("inbox") && path === "/api/notifications/unread") return Response.json({ unread: 3 });
  if (params.has("inbox") && path === "/api/notifications") return Response.json({ items: [], next: null, unread: 3 });
  if (path === "/api/tags") return Response.json([{ name: "note", count: 3 }, { name: "task", count: 1 }]);
  if (path === "/api/vault" || path === "/api/vault/info") return Response.json({ name: "Personal vault", description: "", stats: { totalNotes: notes.length, totalTags: 2, totalLinks: 0 } });
  if (path === "/api/vault/stats" || path === "/api/stats") return Response.json({ totalNotes: notes.length, totalTags: 2, totalLinks: 0 });
  if (path === "/api/graph") return Response.json({ nodes: notes.map((n) => ({ id: n.id, path: n.path, tags: n.tags })), edges: [] });
  if (path.startsWith("/api/") || path.startsWith("/acl/") || path.startsWith("/auth/")) return Response.json({ error: "unsupported_fixture_route", path }, { status: 501 });
  return nativeFetch(input, init);
};
setActiveVault("primary");
await fetchMe();
startOutboxSync();
useUIStore.setState({ contextPanelOpen: false, sidebarWidth: 240, sidebarOpen: !params.has("collapsed") });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ createShareLink: async () => "", getAccess: async () => ({ note: { id: "workspace", title: "A living workspace", tags: [], visibility: "private" }, people: [], links: [], tagAccess: [], canManageLinks: true, allowedLevels: ["view", "comment", "suggest", "edit"] }) }}>
    <App skipOnboarding initialTab={{ id: "workspace", title: "A living workspace", type: "document" }} />
    <OfflineIndicator />
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
