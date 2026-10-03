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
  { id: "field-notes", path: "Journal/Field notes", content: "<p>Notes from the last conversation about the workshop budget.</p>", tags: ["note"], metadata: { type: "document", prism_creator: "owner@example.test" }, createdAt: recent, updatedAt: recent },
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
};
Object.assign(window, { prismShell: controls, prismShellUI: useUIStore });
let seq = 0;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (!navigator.onLine && (path.startsWith("/api/") || path.startsWith("/auth/"))) throw new TypeError("Failed to fetch");
  if (path === "/auth/me") return Response.json({ authenticated: true, email: "owner@example.test", name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/me/preferences") {
    if (method === "PUT") { const body = JSON.parse(String(init?.body)); controls.preferences = { ...controls.preferences, ...body.preferences }; controls.revision++; }
    const items = Object.fromEntries(notes.map((n) => [n.id, { path: n.path, title: n.path!.split("/").pop()!, tags: n.tags ?? [], type: n.metadata?.type as string | undefined }]));
    return Response.json({ preferences: { version: 1, favorites: controls.preferences.favorites, recents: controls.preferences.recents, sidebar: { order: [], collapsed: [] } }, revision: controls.revision, items });
  }
  if (path === "/api/tree") return Response.json(notes.map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, prismType: n.metadata?.prism_type })));
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
    note.updatedAt = `2026-10-02T00:01:${String(++seq).padStart(2, "0")}.000Z`;
    persistMeta(note);
    return Response.json({ ok: true, id: note.id, updatedAt: note.updatedAt, metadata: body.set });
  }
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    const note = notes.find((n) => n.id === decodeURIComponent(noteId));
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "GET") controls.reads.push(note.id);
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      controls.writes.push({ method, path, body });
      if (controls.hold) await new Promise<void>((resolve) => controls.release.push(resolve));
      if (controls.failStatus) return Response.json({ error: "fixture_failure" }, { status: controls.failStatus });
      Object.assign(note, body, { metadata: { ...note.metadata, ...body.metadata }, updatedAt: `2026-10-02T00:00:${String(++seq).padStart(2, "0")}.000Z` });
      if (body.metadata) persistMeta(note);
    }
    return Response.json(note);
  }
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
