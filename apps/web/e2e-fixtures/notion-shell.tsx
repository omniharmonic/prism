/**
 * Wave 2E shell fixture: the real App + HttpVaultClient (outbox, read cache,
 * sync state) over an intercepted fetch with fictional notes. Controls on
 * `window.prismShell` hold, fail or count writes and searches.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { InvalidationSourceProvider } from "../../../packages/core/src/data/InvalidationContext";
import type { InvalidationHandlers, InvalidationSource } from "../../../packages/core/src/lib/events/invalidation";
import { App, AccountProvider, AgentClientProvider, CollabDocumentProvider, CollabSharingProvider, PlatformProvider, VaultClientProvider, useAgentChatStore, useUIStore, type AgentClient, type AgentSessionSummary, type Note } from "@prism/core";
import { filtersToParams, matchesFilters, parseSearchFilters, queryTerms, searchMatches, sortSearchRows } from "@prism/core/search";
import { inferContentType } from "../../../packages/core/src/lib/schemas/content-types";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { agentScope, fetchMe, setActiveVault } from "../src/config";
import { OfflineIndicator } from "../src/offline/OfflineIndicator";
import { startOutboxSync, setStaleSendingMsForTests } from "../src/offline/outbox";
import { logout } from "../src/config";
import { webAccount } from "../src/account";
import { fakeMove } from "./fake-move";

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
// ?authors (NP-SR-04): the agenda was created by someone else and last edited by the owner.
if (params.has("authors")) notes.find((n) => n.id === "agenda")!.metadata = { ...notes.find((n) => n.id === "agenda")!.metadata, prism_last_writer: "u_00000000000000aa" };
// ?headings (copy link to heading, expand/collapse all toggles): the agenda is a long page whose
// "Next steps" heading appears twice, with three toggles (one nested).
if (params.has("headings")) {
  const filler = Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1} of the agenda.</p>`).join("");
  notes.find((n) => n.id === "agenda")!.content = `<h2>Plan</h2>${filler}<h2>Next steps</h2>${filler}<h3>Next steps</h3><p>The second one.</p><details data-type="toggle"><summary>First toggle</summary><p>Inside the first toggle.</p><details data-type="toggle"><summary>Nested toggle</summary><p>Inside the nested toggle.</p></details></details><details data-type="toggle"><summary>Second toggle</summary><p>Inside the second toggle.</p></details>${filler}`;
}
// ?dbrows (NP-OF-05): the tracker is a configured database over two task pages.
if (params.has("dbrows")) {
  notes.find((n) => n.id === "tracker")!.metadata = { prism_type: "database", prism_creator: "owner@example.test", prism_database: { version: 1, source: { tags: ["task"] }, views: [{ id: "v-table", name: "All tasks", type: "table", visible: ["status"] }] } };
  notes.push(
    { id: "task-venue", path: "Projects/Prism/Tasks/Book the venue", content: "", tags: ["task"], metadata: { status: "todo", priority: "medium" }, createdAt: recent, updatedAt: recent },
    { id: "task-invites", path: "Projects/Prism/Tasks/Send invitations", content: "", tags: ["task"], metadata: { status: "todo", priority: "low" }, createdAt: recent, updatedAt: recent },
  );
}
// ?manyfolders: a long tree (forty top-level folders ahead of "Projects"), so a row that is
// revealed has to be scrolled to.
if (params.has("manyfolders")) for (let i = 1; i <= 40; i++) notes.push({ id: `archive-${i}`, path: `Archive ${String(i).padStart(2, "0")}/Notes`, content: "", tags: [], metadata: { type: "document" }, createdAt: recent, updatedAt: recent });
// Metadata written by the app survives reloads ("another device" = a fresh page).
const savedMeta = JSON.parse(sessionStorage.getItem("notion-shell-meta") ?? "{}") as Record<string, Record<string, unknown>>;
for (const n of notes) if (savedMeta[n.id]) n.metadata = { ...n.metadata, ...savedMeta[n.id] };
const persistMeta = (n: Note) => { savedMeta[n.id] = { ...(n.metadata ?? {}) }; sessionStorage.setItem("notion-shell-meta", JSON.stringify(savedMeta)); };
const controls = {
  writes: [] as Array<{ method: string; path: string; body: unknown }>,
  searches: [] as string[],
  /** A slow search: while set, every /api/search answer waits for releaseSearch(). */
  searchHold: false,
  searchWaiting: [] as Array<() => void>,
  releaseSearch: () => { controls.searchHold = false; controls.searchWaiting.splice(0).forEach((r) => r()); },
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
  /** Pages this account may not move to the Trash (403 on the trash route). */
  trashRefused: [] as string[],
  /** Pages this account can no longer see (absent from the tree, 403 on read). */
  hidden: [] as string[],
  refreshMe: () => fetchMe(),
  /** Another device/agent changed the page on the server. */
  serverEdit: (id: string, content: string) => { const n = notes.find((x) => x.id === id)!; n.content = content; n.updatedAt = bump(); },
  note: (id: string) => notes.find((x) => x.id === id),
  all: () => notes,
  /** The events channel (`/api/events` stand-in): ids only, plus the server's `tree` flag. */
  event: (id: string, tree = false) => eventHandlers?.onEvent(tree ? { type: "note", id, op: "upsert", tree: true } : { type: "note", id, op: "upsert" }),
  /** Note ids whose GET asked the server for its current state (`cache: "reload"` / `"no-store"`). */
  freshReads: [] as string[],
  treeReads: 0,
  /** One-shot: the next GET of this note is answered with this OLDER copy (a reuse window / slow read). */
  staleOnce: {} as Record<string, Note>,
  serverCreate: (path: string, content: string) => { notes.push({ id: `foreign-${++createdSeq}`, path, content, tags: [], metadata: { type: "document" }, createdAt: bump(), updatedAt: bump() }); },
  switchActor: async (email: string) => { controls.actor = email; await fetchMe(); },
};
let eventHandlers: InvalidationHandlers | null = null;
const eventSource: InvalidationSource = { open(handlers) { eventHandlers = handlers; handlers.onOpen(); return () => { if (eventHandlers === handlers) eventHandlers = null; }; } };
let seq = 0;
let createdSeq = 0;
const bump = () => `2026-10-02T00:${String(Math.floor(++seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`;
if (params.has("stale")) setStaleSendingMsForTests(Number(params.get("stale")));
Object.assign(window, { prismShellLogout: logout, prismShell: controls, prismShellUI: useUIStore, prismShellClient: httpVaultClient });
/** `?agent[=running|queued|done]` (NP-PG-06 / PG-14 / SR-06): an AgentClient like the one main.tsx
 *  provides to the server owner, over one seeded session. `prismShellAgent.status` is what the
 *  server would answer for its latest turn; creates and turns are recorded, never run. */
const agentFixture = { status: (params.get("agent") || "done") as "running" | "queued" | "done", lists: 0, creates: [] as unknown[], turns: [] as unknown[] };
const agentSession = (): AgentSessionSummary => ({ id: "11111111-1111-4111-8111-111111111111", vault_id: "primary", owner_email: "owner@example.test", title: "Draft the workshop plan", profile: "vault-ro", note_id: null, cli_session_id: null, status: agentFixture.status === "done" ? "idle" : "running", transcript_note_id: null, cost_usd: 0, created_at: Date.parse(recent), updated_at: Date.parse(recent), turnCount: 1, lastTurnAt: Date.parse(recent), lastTurnStatus: agentFixture.status });
const agentClient: AgentClient | null = params.has("agent") ? {
  scope: () => agentScope() ?? "",
  listSessions: async () => { agentFixture.lists++; return [agentSession()]; },
  getSession: async () => ({ session: agentSession(), turns: [] }),
  createSession: async (p) => { agentFixture.creates.push(p ?? null); return { sessionId: agentSession().id, session: agentSession() }; },
  sendTurn: async (_id, prompt, opts) => { agentFixture.turns.push({ prompt, opts: opts ?? null }); return { turnId: "fixture-turn", status: "done" }; },
  streamSession: () => () => {},
  cancelTurn: async () => true,
  archiveSession: async () => {},
} : null;
Object.assign(window, { prismShellAgent: agentFixture, prismShellAgentStore: useAgentChatStore });
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
  // Sign-out (wave 3): the session ends on the "server"; it stays ended across the reload.
  if (path === "/auth/logout" && method === "POST") { sessionStorage.setItem("notion-shell-signed-out", String(Number(sessionStorage.getItem("notion-shell-signed-out") ?? 0) + 1)); return Response.json({ ok: true }); }
  if (path === "/auth/me" && (controls.signedOut || sessionStorage.getItem("notion-shell-signed-out"))) return Response.json({ authenticated: false });
  if (path === "/auth/me") return Response.json({ authenticated: true, email: controls.actor, name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/me/preferences") {
    if (method === "PUT") { const body = JSON.parse(String(init?.body)); controls.preferences = { ...controls.preferences, ...body.preferences }; controls.revision++; }
    const items = Object.fromEntries(notes.map((n) => [n.id, { path: n.path, title: n.path!.split("/").pop()!, tags: n.tags ?? [], type: n.metadata?.type as string | undefined }]));
    return Response.json({ preferences: { version: 1, favorites: controls.preferences.favorites, recents: controls.preferences.recents, sidebar: (controls.preferences as { sidebar?: { order: string[]; collapsed: string[] } }).sidebar ?? { order: [], collapsed: [] } }, revision: controls.revision, items });
  }
  if (path === "/api/tree") controls.treeReads++;
  if (path === "/api/tree") return Response.json(notes.filter((n) => !controls.hidden.includes(n.id)).map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, prismType: n.metadata?.prism_type, ...(typeof n.metadata?.icon === "string" ? { icon: n.metadata.icon } : {}) })));
  // What the search route can filter by (absent on an older server: ?oldserver).
  if (path === "/api/search/filters") return params.has("oldserver") ? Response.json({ error: "not_found" }, { status: 404 }) : Response.json({ filters: ["author", "editor"], identity: !params.has("linkviewer") });
  if (path === "/api/search") {
    controls.searches.push(url.search);
    if (controls.searchHold) await new Promise<void>((resolve) => controls.searchWaiting.push(resolve));
    const q = url.searchParams.get("q") ?? "";
    const terms = queryTerms(q);
    const f = parseSearchFilters((k) => url.searchParams.get(k) ?? undefined);
    if (f.author === "me") f.author = "owner@example.test";
    // The last-writer stamp is an opaque id, never an address; an older server knows no `editor`.
    if (f.editor === "me") f.editor = "u_00000000000000aa";
    if (params.has("oldserver")) delete f.editor;
    // Vault scope arrives as a header; the "research" vault holds one other page.
    const vault = new Headers(init?.headers).get("X-Prism-Vault");
    if (vault === "research") return Response.json(terms.every((t) => "workshop field study".includes(t)) ? [{ id: "study", path: "Studies/Workshop field study", tags: [], metadata: { type: "document" }, createdAt: recent, updatedAt: recent, _matches: searchMatches({ id: "study", path: "Studies/Workshop field study", content: "<p>A study of the workshop.</p>" }, terms) }] : []);
    const hits = notes.filter((n) => terms.every((t) => (n.path + " " + n.content).toLowerCase().includes(t)))
      .filter((n) => matchesFilters(n, f, terms, (x) => inferContentType(x as Note)))
      .map((n) => ({ ...n, content: undefined, _matches: searchMatches(n, terms) }));
    // An older server (?oldserver) knows no `sort=` and answers in its own order.
    return Response.json(params.has("oldserver") ? hits : sortSearchRows(hits, f.sort));
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
  // "Move to" (POST /api/notes/:id/blocks/append): the SERVER appends to the target with its
  // own compare-and-set and the change reaches every open copy of that page as an event.
  const appendTo = method === "POST" ? path.match(/^\/api\/notes\/([^/]+)\/blocks\/append$/)?.[1] : undefined;
  if (appendTo) {
    const target = notes.find((n) => n.id === decodeURIComponent(appendTo));
    if (!target) return Response.json({ error: "not_found" }, { status: 404 });
    const body = JSON.parse(String(init?.body)) as { html: string; requestId: string };
    controls.writes.push({ method, path, body });
    target.content = `${target.content ?? ""}${body.html}`;
    target.updatedAt = bump();
    setTimeout(() => controls.event(target.id), 0);
    return respond({ ok: true, live: false, updatedAt: target.updatedAt });
  }
  // Rename / move (POST /api/notes/:id/move): the page and its sub-pages, compare-and-set.
  const moveId = method === "POST" ? path.match(/^\/api\/notes\/([^/]+)\/move$/)?.[1] : undefined;
  if (moveId) {
    const body = JSON.parse(String(init?.body));
    controls.writes.push({ method, path, body });
    if (controls.failStatus) return Response.json({ error: "fixture_failure" }, { status: controls.failStatus });
    const moved = fakeMove(notes, decodeURIComponent(moveId), body, bump);
    return respond(moved.body, { status: moved.status });
  }
  // Trash (POST /api/notes/:id/trash) and restore (POST /api/trash/:id/restore): the page and
  // what is inside it, tagged — never deleted. `trashRefused` = pages this account may not trash.
  const trashId = method === "POST" ? path.match(/^\/api\/notes\/([^/]+)\/trash$/)?.[1] : undefined;
  const restoreId = method === "POST" ? path.match(/^\/api\/trash\/([^/]+)\/restore$/)?.[1] : undefined;
  if (trashId || restoreId) {
    const root = notes.find((n) => n.id === decodeURIComponent((trashId ?? restoreId)!));
    controls.writes.push({ method, path, body: null });
    if (!root) return Response.json({ error: "not_found" }, { status: 404 });
    if (trashId && controls.trashRefused.includes(root.id)) return Response.json({ error: "forbidden", message: "You can’t move this page to Trash." }, { status: 403 });
    const group = notes.filter((n) => n === root || (!!root.path && !!n.path && n.path.startsWith(`${root.path}/`)));
    for (const n of group) { n.tags = trashId ? [...new Set([...(n.tags ?? []), "prism-trashed"])] : (n.tags ?? []).filter((t) => t !== "prism-trashed"); n.updatedAt = bump(); }
    return respond(trashId ? { rootId: root.id, trashed: group.map((n) => n.id) } : { restored: group.map((n) => n.id) });
  }
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    const note = notes.find((n) => n.id === decodeURIComponent(noteId));
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (controls.hidden.includes(note.id)) return Response.json({ error: "forbidden" }, { status: 403 });
    if (method === "GET") controls.reads.push(note.id);
    if (method === "GET" && (init?.cache === "reload" || init?.cache === "no-store")) controls.freshReads.push(note.id);
    if (method === "GET" && controls.staleOnce[note.id]) { const stale = controls.staleOnce[note.id]!; delete controls.staleOnce[note.id]; return Response.json(viewerNote(stale)); }
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
      return Response.json({ ...viewerNote(note), links });
    }
    return Response.json(viewerNote(note));
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
/** `?as=suggest|governed|creator`: the gateway's non-owner annotation (wave 3 gaps #1). */
function viewerNote(note: Note): Note {
  const as = params.get("as");
  if (!as) return note;
  const caps = as === "creator" ? ["view", "create"] : ["view", "comment", "suggest"];
  return { ...note, _level: as === "creator" ? "view" : "suggest", _caps: caps, ...(as === "governed" ? { _review: "governance" as const } : {}) };
}
/** A stand-in for the web shell's live editor: proves WHICH editor Canvas routes to. */
const liveStub = { useLiveCollab: (id: string) => !!id, CollabDocument: ({ noteId }: { noteId: string }) => <div data-testid="live-collab-doc" data-note={noteId}>Live collaborative document</div> };
const Live = ({ children }: { children: React.ReactNode }) => params.has("as") ? <CollabDocumentProvider value={liveStub}>{children}</CollabDocumentProvider> : <>{children}</>;
// `?open=<id>`: boot into that page, as main.tsx does for `/page/<id>` (the hash stays in the address).
const openAt = { id: notes.find((n) => n.id === params.get("open"))?.id ?? "workspace", title: params.has("open") ? "Page" : "A living workspace", type: "document" };
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
    <AccountProvider value={params.has("account") ? webAccount : null}><AgentClientProvider client={agentClient}><Live><InvalidationSourceProvider source={params.has("events") ? eventSource : null}><App skipOnboarding initialTab={openAt} /></InvalidationSourceProvider></Live></AgentClientProvider></AccountProvider>
    <OfflineIndicator />
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
