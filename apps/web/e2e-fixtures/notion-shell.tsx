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
import { startOutboxSync, setStaleSendingMsForTests } from "../src/offline/outbox";
import { logout } from "../src/config";

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
  /** Slow responses: a write to one of these note ids (or "POST" for creates) waits for releaseHeld(). */
  holdIds: [] as string[],
  held: {} as Record<string, Array<() => void>>,
  releaseHeld: (id: string) => { controls.holdIds = controls.holdIds.filter((x) => x !== id); (controls.held[id] ?? []).splice(0).forEach((r) => r()); },
  /** Failure rules, consumed in order: `status` = HTTP status, "network" = the request never
   *  arrives, "lost" = the server APPLIES the write and the response is lost. */
  failures: [] as Array<{ method: string; match: string; mode: number | "network" | "lost"; times: number }>,
  /** navigator.onLine stays true but nothing answers (pm2 restart, tunnel down). */
  unreachable: false,
  signedOut: false,
  /** Pages this account can no longer see (absent from the tree, 403 on read). */
  hidden: [] as string[],
  refreshMe: () => fetchMe(),
  /** Another device/agent changed the page on the server. */
  serverEdit: (id: string, content: string) => { const n = notes.find((x) => x.id === id)!; n.content = content; n.updatedAt = bump(); },
  note: (id: string) => notes.find((x) => x.id === id),
  all: () => notes,
  serverCreate: (path: string, content: string) => { notes.push({ id: `foreign-${++createdSeq}`, path, content, tags: [], metadata: { type: "document" }, createdAt: bump(), updatedAt: bump() }); },
  switchActor: async (email: string) => { controls.actor = email; await fetchMe(); },
};
let seq = 0;
let createdSeq = 0;
const bump = () => `2026-10-02T00:${String(Math.floor(++seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`;
if (params.has("stale")) setStaleSendingMsForTests(Number(params.get("stale")));
Object.assign(window, { prismShellLogout: logout, prismShell: controls, prismShellUI: useUIStore, prismShellClient: httpVaultClient });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (!navigator.onLine && (path.startsWith("/api/") || path.startsWith("/auth/"))) throw new TypeError("Failed to fetch");
  if (controls.unreachable && (path.startsWith("/api/") || path.startsWith("/auth/"))) throw new TypeError("Failed to fetch");
  // Slow / failing writes.
  let lost = false;
  if (method !== "GET") {
    const key = method === "POST" && path === "/api/notes" ? "POST" : decodeURIComponent(path.split("/")[3] ?? "");
    if (controls.holdIds.includes(key)) await new Promise<void>((resolve) => (controls.held[key] ??= []).push(resolve));
    const rule = controls.failures.find((f) => f.times > 0 && f.method === method && path.includes(f.match));
    if (rule) {
      rule.times--;
      controls.writes.push({ method, path, body: { failed: rule.mode } });
      if (rule.mode === "network") throw new TypeError("Failed to fetch");
      if (typeof rule.mode === "number") return Response.json({ error: "fixture_failure" }, { status: rule.mode });
      lost = true;
    }
  }
  const respond = (body: unknown, init2?: ResponseInit) => { if (lost) throw new TypeError("Failed to fetch"); return Response.json(body, init2); };
  if (path === "/auth/me" && controls.signedOut) return Response.json({ authenticated: false });
  if (path === "/auth/me") return Response.json({ authenticated: true, email: controls.actor, name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/me/preferences") {
    if (method === "PUT") { const body = JSON.parse(String(init?.body)); controls.preferences = { ...controls.preferences, ...body.preferences }; controls.revision++; }
    const items = Object.fromEntries(notes.map((n) => [n.id, { path: n.path, title: n.path!.split("/").pop()!, tags: n.tags ?? [], type: n.metadata?.type as string | undefined }]));
    return Response.json({ preferences: { version: 1, favorites: controls.preferences.favorites, recents: controls.preferences.recents, sidebar: { order: [], collapsed: [] } }, revision: controls.revision, items });
  }
  if (path === "/api/tree") return Response.json(notes.filter((n) => !controls.hidden.includes(n.id)).map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, prismType: n.metadata?.prism_type, ...(typeof n.metadata?.icon === "string" ? { icon: n.metadata.icon } : {}) })));
  if (path === "/api/search") {
    controls.searches.push(url.search);
    const q = url.searchParams.get("q") ?? "";
    const terms = queryTerms(q);
    const f = parseSearchFilters((k) => url.searchParams.get(k) ?? undefined);
    if (f.author === "me") f.author = "owner@example.test";
    // Vault scope arrives as a header; the "research" vault holds one other page.
    const vault = new Headers(init?.headers).get("X-Prism-Vault");
    if (vault === "research") return Response.json(terms.every((t) => "workshop field study".includes(t)) ? [{ id: "study", path: "Studies/Workshop field study", tags: [], metadata: { type: "document" }, createdAt: recent, updatedAt: recent, _matches: searchMatches({ id: "study", path: "Studies/Workshop field study", content: "<p>A study of the workshop.</p>" }, terms) }] : []);
    const hits = notes.filter((n) => terms.every((t) => (n.path + " " + n.content).toLowerCase().includes(t)))
      .filter((n) => matchesFilters(n, f, terms, (x) => inferContentType(x as Note)))
      .map((n) => ({ ...n, content: undefined, _matches: searchMatches(n, terms) }));
    return Response.json(hits);
  }
  if (path === "/api/search/semantic") return Response.json({ error: "semantic_index_primary_only" }, { status: 409 });
  if (path === "/api/notes" && method === "GET") return Response.json(notes
    .filter((n) => !controls.hidden.includes(n.id))
    .filter((n) => !url.searchParams.has("path") || n.path === url.searchParams.get("path"))
    .filter((n) => !url.searchParams.has("search") || (n.content ?? "").includes(url.searchParams.get("search")!)));
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
    // Per-field CAS, like the server: a field whose current value differs from `expect` → 409.
    const stale = Object.keys(body.expect ?? {}).filter((k) => JSON.stringify(note.metadata?.[k] ?? null) !== JSON.stringify(body.expect[k] ?? null));
    if (stale.length) return Response.json({ error: "conflict", fields: stale, current: Object.fromEntries(stale.map((k) => [k, note.metadata?.[k] ?? null])) }, { status: 409 });
    note.metadata = { ...note.metadata, ...body.set };
    note.updatedAt = bump();
    persistMeta(note);
    return respond({ id: note.id, updatedAt: note.updatedAt, metadata: note.metadata });
  }
  if (path === "/api/notes" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    controls.writes.push({ method, path, body });
    // The server's create is fail-if-exists.
    if (notes.some((n) => n.path === body.path)) return Response.json({ error: "conflict", error_type: "path_conflict" }, { status: 409 });
    const created: Note = { id: `created-${++createdSeq}`, content: " ", metadata: {}, tags: [], ...body, createdAt: bump(), updatedAt: bump() };
    notes.push(created);
    return respond(created);
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
      const { if_updated_at: _base, force: _force, tags: tagDelta, ...fields } = body;
      const tags = new Set(note.tags ?? []);
      for (const t of tagDelta?.add ?? []) tags.add(t);
      for (const t of tagDelta?.remove ?? []) tags.delete(t);
      Object.assign(note, fields, { tags: [...tags], metadata: { ...note.metadata, ...body.metadata }, updatedAt: bump() });
      if (body.metadata) persistMeta(note);
      if (lost) throw new TypeError("Failed to fetch");
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
// `?persisted` leaves the sidebar as the app restored it from this device (NP-SB-11).
useUIStore.setState(params.has("persisted") ? { contextPanelOpen: false } : { contextPanelOpen: false, sidebarWidth: 240, sidebarOpen: !params.has("collapsed") });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ ...(params.has("vaults") ? {
      listVaults: async () => [{ id: "primary", label: "Personal vault", vault: "personal", active: true }, { id: "research", label: "Shared research", vault: "research", active: false }],
      getActiveVault: () => "primary",
      setActiveVault: (id: string) => { (controls as unknown as { switchedVault?: string }).switchedVault = id; },
    } : {}), createShareLink: async () => "", getAccess: async () => ({ note: { id: "workspace", title: "A living workspace", tags: [], visibility: "private" }, people: [], links: [], tagAccess: [], canManageLinks: true, allowedLevels: ["view", "comment", "suggest", "edit"] }) }}>
    <App skipOnboarding initialTab={{ id: "workspace", title: "A living workspace", type: "document" }} />
    <OfflineIndicator />
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
