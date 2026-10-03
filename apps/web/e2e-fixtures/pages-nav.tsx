/**
 * Pages & navigation fixture: the real shared workspace over an in-page fake of
 * the Prism Server pages API (nested-page move, Trash, synced preferences), built
 * on the SAME pure model the server uses (@prism/core lib/pages/model.ts).
 * Fictional data; never connects to a live server. Templates are seeded HERE only.
 *
 * Query flags: ?open=<id> initial page · ?prefs=<json> server preferences ·
 * ?legacy (no preferences route → per-device shortcuts) · ?fail-move=<id> (that
 * note's path writes fail once, for partial-move recovery) · ?shared (pages shared
 * with the viewer + a move that changes access) · ?guest[=empty] (a guest account).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App, PlatformProvider, VaultClientProvider, CollabSharingProvider, useUIStore, type Note } from "@prism/core";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";
import {
  TRASH_TAG,
  TRASH_META,
  isProtectedPath,
  isTrashed,
  isUnder,
  movedPath,
  normalizePagePath,
  pageTitle,
  planSubtreeMove,
  protectionReason,
  sanitizePreferences,
  EMPTY_PREFERENCES,
  type PagePreferences,
} from "../../../packages/core/src/lib/pages/model";

const params = new URLSearchParams(location.search);
let clock = Date.UTC(2026, 9, 1, 12);
const stamp = () => new Date((clock += 1000)).toISOString();
const doc = (id: string, path: string, html: string, extra: Partial<Note> = {}): Note => ({
  id, path, content: html, tags: ["page"], metadata: { type: "document" }, createdAt: stamp(), updatedAt: stamp(), ...extra,
});
const notes: Note[] = [
  doc("prism", "vault/Projects/Prism", "<h2>About</h2><p>The Prism project page.</p>"),
  doc("living", "vault/Projects/Prism/A living workspace", "<h2>Purpose</h2><p>A shared place to think, write, and build with the same context.</p>"),
  doc("plan", "vault/Projects/Prism/Plan", "<p>The plan.</p>"),
  doc("week1", "vault/Projects/Prism/Plan/Week 1", "<p>First week.</p>"),
  doc("archive", "vault/Archive", "<p>Old things.</p>"),
  doc("weekly", "vault/Journal/Weekly review", "<p>What moved forward this week?</p>"),
  doc("watersheds", "vault/Areas/Research/Bioregions/Watersheds/South Platte", "<p>River notes.</p>"),
  doc("room", "vault/messages/chat/Team room", "Team room", { tags: ["message-thread"], metadata: { type: "message-thread" } }),
  // Built-in templates (fixture/tests only — never seeded into a live vault).
  doc("tpl-meeting", "_templates/Meeting notes", "<h2>Attendees</h2><ul><li></li></ul><h2>Agenda</h2><ol><li></li></ol><h2>Decisions</h2><p></p><h2>Action items</h2><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul>", { tags: ["template", "meeting"], metadata: { type: "document", title: "Meeting notes", status: "draft" } }),
  doc("tpl-brief", "_templates/Project brief", "<h2>Problem</h2><p></p><h2>Goals</h2><ul><li></li></ul><h2>Scope</h2><p></p><h2>Milestones</h2><p></p>", { tags: ["template", "project"], metadata: { type: "document", title: "Project brief", status: "planning" } }),
  doc("tpl-task", "_templates/Task", "<p>What needs doing, and why.</p>", { tags: ["template", "task"], metadata: { type: "task", title: "Task", status: "todo", priority: "medium" } }),
];
const writes: Array<Record<string, unknown>> = [];
// The fake server's preference row survives a reload (sessionStorage), like a real server.
const kept = JSON.parse(sessionStorage.getItem("fixture-prefs") ?? "null") as { prefs: PagePreferences; revision: number } | null;
let prefs: PagePreferences = kept?.prefs ?? (params.has("prefs") ? sanitizePreferences(JSON.parse(params.get("prefs")!)) : EMPTY_PREFERENCES);
let revision = kept?.revision ?? (params.has("prefs") ? 1 : 0);
const failOnce = new Set(params.getAll("fail-move"));
const moves = new Map<string, { from: string; to: string }>();
Object.assign(window, { prismFixtureUI: useUIStore, prismFixtureNotes: notes, prismFixtureWrites: writes, prismFixturePrefs: () => ({ prefs, revision }) });
// Wave 3A: `notion-transfer.html` loads this fixture with an extension (extra seed
// notes, the import/export routes, a viewer role). Absent → nothing changes.
const extension = (window as unknown as { prismFixtureExtension?: { seed?: (notes: Note[], make: typeof doc, stamp: () => string) => void; fetch?: (url: URL, method: string, init?: RequestInit) => Promise<Response | null>; sharing?: Record<string, unknown> } }).prismFixtureExtension;
extension?.seed?.(notes, doc, stamp);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const byId = (id: string) => notes.find((n) => n.id === id || n.path === id);
const viewable = (id: string) => { const n = byId(id); return !!n && !isTrashed(n); };
function patch(n: Note, body: Record<string, unknown>) {
  if (typeof body.path === "string") n.path = body.path;
  if (typeof body.content === "string") n.content = body.content;
  if (body.metadata && typeof body.metadata === "object") {
    const m: Record<string, unknown> = { ...(n.metadata ?? {}) };
    for (const [k, v] of Object.entries(body.metadata as Record<string, unknown>)) v === null ? delete m[k] : (m[k] = v);
    n.metadata = m;
  }
  const t = body.tags as { add?: string[]; remove?: string[] } | undefined;
  if (t && !Array.isArray(t)) n.tags = [...new Set([...(n.tags ?? []).filter((x) => !(t.remove ?? []).includes(x)), ...(t.add ?? [])])];
  n.updatedAt = stamp();
}
function prefsResponse() {
  const fav = prefs.favorites.filter(viewable);
  const rec = prefs.recents.filter(viewable);
  const items: Record<string, unknown> = {};
  for (const id of [...fav, ...rec]) { const n = byId(id)!; items[id] = { path: n.path, title: pageTitle(n.path), tags: n.tags ?? [], type: n.metadata?.type }; }
  return { preferences: { ...prefs, favorites: fav, recents: rec }, revision, items };
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return json({ error: "external_network_disabled_in_fixture" }, 503);
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};
  const extended = await extension?.fetch?.(url, method, init);
  if (extended) return extended;
  if (path === "/auth/me") return json({ authenticated: true, email: "owner@example.test", name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/tree") return json(notes.filter((n) => !isTrashed(n)).map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, ...(typeof n.metadata?.prism_order === "number" ? { order: n.metadata.prism_order } : {}) })));
  if (path === "/api/me/preferences") {
    if (params.has("legacy")) return json({ error: "unsupported_fixture_route" }, 501);
    if (method === "PUT") {
      writes.push({ preferences: body });
      if (body.ifRevision !== undefined && body.ifRevision !== revision) return json({ error: "conflict", revision }, 409);
      prefs = sanitizePreferences(body.preferences);
      revision++;
      sessionStorage.setItem("fixture-prefs", JSON.stringify({ prefs, revision }));
    }
    return json(prefsResponse());
  }
  if (path === "/api/trash" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const trashed = notes.filter(isTrashed);
    const items = trashed
      .filter((n) => n.metadata?.[TRASH_META.root] === n.id && (!q || (n.path ?? "").toLowerCase().includes(q)))
      .map((n) => ({ id: n.id, path: n.path, title: pageTitle(n.path), trashedAt: n.metadata?.[TRASH_META.at], trashedBy: "owner@example.test", descendants: trashed.filter((x) => x.id !== n.id && x.metadata?.[TRASH_META.root] === n.id).length, canRestore: true, canDelete: true }));
    return json({ items, total: items.length, retentionDays: 30, autoPurge: false });
  }
  const trashAct = path.match(/^\/api\/trash\/([^/]+)(\/restore)?$/);
  if (trashAct) {
    const root = byId(decodeURIComponent(trashAct[1]!));
    if (!root) return json({ error: "not_found" }, 404);
    const group = notes.filter((n) => n.id === root.id || n.metadata?.[TRASH_META.root] === root.id);
    writes.push({ trash: trashAct[2] ? "restore" : "delete", id: root.id });
    if (trashAct[2]) {
      for (const n of group) patch(n, { metadata: { [TRASH_META.at]: null, [TRASH_META.by]: null, [TRASH_META.root]: null, [TRASH_META.path]: null }, tags: { remove: [TRASH_TAG] } });
      return json({ ok: true, restored: group.map((n) => n.id) });
    }
    if (!isTrashed(root)) return json({ error: "not_in_trash" }, 409);
    for (const n of group) notes.splice(notes.indexOf(n), 1);
    return json({ ok: true, deleted: group.map((n) => n.id) });
  }
  const meta = path.match(/^\/api\/notes\/([^/]+)\/meta$/);
  if (meta && method === "POST") {
    const n = byId(decodeURIComponent(meta[1]!));
    if (!n) return json({ error: "not_found" }, 404);
    writes.push({ meta: n.id, ...body });
    if (body.if_updated_at !== n.updatedAt) return json({ error: "conflict" }, 409);
    patch(n, { metadata: body.set });
    return json({ ok: true, id: n.id, updatedAt: n.updatedAt, metadata: body.set });
  }
  const op = path.match(/^\/api\/notes\/([^/]+)\/(move|trash)$/);
  if (op) {
    const root = byId(decodeURIComponent(op[1]!));
    if (!root) return json({ error: "not_found" }, 404);
    writes.push({ [op[2]!]: root.id, ...body });
    const reason = protectionReason(root);
    if (op[2] === "trash") {
      if (reason) return json({ error: "protected", reason }, 403);
      const group = [root, ...notes.filter((n) => n !== root && isUnder(n.path, root.path!) && !isTrashed(n))];
      const at = stamp();
      for (const n of group) patch(n, { metadata: { [TRASH_META.at]: at, [TRASH_META.by]: "owner@example.test", [TRASH_META.root]: root.id, [TRASH_META.path]: n.path }, tags: { add: [TRASH_TAG] } });
      return json({ ok: true, rootId: root.id, trashed: group.map((n) => n.id) });
    }
    const journal = body.moveId ? moves.get(body.moveId) : undefined;
    if (body.moveId && (!journal || body.if_updated_at !== root.updatedAt)) return json({ error: "conflict" }, 409);
    const target = journal ? journal.to : body.newPath !== undefined ? normalizePagePath(body.newPath) : movedPath(root.path!, body.newParentPath === "" ? "" : normalizePagePath(body.newParentPath) ?? "");
    if (!target) return json({ error: "bad_request" }, 400);
    const resuming = !!journal;
    const from = journal ? journal.from : root.path!;
    if (reason || isProtectedPath(target)) return json({ error: "protected", reason: reason ?? "That location is kept in sync by an integration." }, 403);
    if (isUnder(target, from)) return json({ error: "into_own_subtree", reason: "A page can’t move inside itself." }, 400);
    if (!resuming && body.if_updated_at !== root.updatedAt) return json({ error: "conflict", reason: "This page changed since you opened it. Reload and try again." }, 409);
    const plan = planSubtreeMove(notes.map((n) => ({ id: n.id, path: n.path })), from, target, root.id);
    const moving = new Set(plan.map((m) => m.id));
    const clash = plan.find((m) => notes.some((n) => !moving.has(n.id) && n.path?.toLowerCase() === m.to.toLowerCase()));
    if (clash) return json({ error: "path_conflict", path: clash.to, reason: `A page already exists at ${clash.to}.` }, 409);
    const moved = [];
    for (const m of plan) {
      if (failOnce.delete(m.id)) {
        const moveId = `move-${moves.size + 1}`;
        moves.set(moveId, { from, to: target });
        return json({ error: "partial_move", moveId, moved, failed: { ...m, reason: "vault_500" }, remaining: plan.length - moved.length, resume: { moveId, newPath: target } }, 207);
      }
      patch(byId(m.id)!, { path: m.to });
      moved.push({ id: m.id, from: m.from, to: m.to });
    }
    return json({ ok: true, path: target, moved, wikilinks: "vault_cascade" });
  }
  if (path === "/api/notes" && method === "GET") {
    const tag = url.searchParams.get("tag");
    return json(notes.filter((n) => !tag || n.tags?.includes(tag)).map((n) => ({ ...n, content: undefined })));
  }
  if (path === "/api/notes" && method === "POST") {
    writes.push({ create: body });
    if (notes.some((n) => n.path === body.path)) return json({ error: "conflict", error_type: "path_conflict" }, 409);
    const note: Note = { id: `created-${notes.length}`, content: " ", metadata: {}, tags: [], ...body, createdAt: stamp(), updatedAt: stamp() };
    notes.push(note);
    return json(note);
  }
  const one = path.match(/^\/api\/notes\/([^/]+)$/);
  if (one) {
    const note = byId(decodeURIComponent(one[1]!));
    if (!note) return json({ error: "not_found" }, 404);
    if (method === "PATCH") {
      writes.push({ patch: note.id, ...body });
      if (body.if_updated_at && body.if_updated_at !== note.updatedAt) return json({ error: "conflict" }, 409);
      patch(note, body);
    }
    return json(note);
  }
  if (path.match(/^\/api\/notes\/[^/]+\/versions$/)) return json({ versions: [], total: 0 });
  // Wave 2D reads (sharing): ?shared = somebody shared "Archive" with sub-pages and
  // "Weekly review" alone; moving a page INTO Archive then changes who can open it.
  if (path === "/api/shared-with-me") {
    if (!params.has("shared") && !params.has("guest")) return json({ items: [], tags: [] });
    if (params.get("guest") === "empty") return json({ items: [], tags: [] });
    return json({ items: [
      { id: "archive", title: "Archive", path: "vault/Archive", scope: "page", level: "edit", sharedAt: clock, sharedBy: { name: "Ada Park" } },
      { id: "weekly", title: "Weekly review", path: "vault/Journal/Weekly review", scope: "note", level: "view", sharedAt: clock, sharedBy: { name: "Ada Park" } },
    ], tags: [] });
  }
  const activity = path.match(/^\/api\/notes\/([^/]+)\/activity$/);
  if (activity) {
    const n = byId(decodeURIComponent(activity[1]!));
    if (!n) return json({ error: "not_found" }, 404);
    return json({ comments: [], shares: [], sharesVisible: false, lastEditor: { kind: "person", name: "Ada Park", self: false }, createdAt: n.createdAt, updatedAt: n.updatedAt });
  }
  const preview = path.match(/^\/api\/notes\/([^/]+)\/access-preview$/);
  if (preview) {
    if (!params.has("shared") || url.searchParams.get("parent") !== "vault/Archive") return json({ willChange: false });
    return json({ willChange: true, gaining: 2, changes: [
      { email: null, name: "Ada Park", avatar: null, from: null, to: "edit" },
      { email: null, name: "Grace Lin", avatar: null, from: null, to: "view" },
    ] });
  }
  if (path === "/api/tags") return json([{ name: "page", count: 7 }, { name: "template", count: 3 }]);
  if (path === "/api/vault" || path === "/api/vault/info") return json({ name: "Personal vault", description: "", stats: { totalNotes: notes.length, totalTags: 2, totalLinks: 0 } });
  if (path === "/api/vault/stats" || path === "/api/stats") return json({ totalNotes: notes.length, totalTags: 2, totalLinks: 0 });
  if (path.startsWith("/api/") || path.startsWith("/acl/") || path.startsWith("/auth/")) return json({ error: "unsupported_fixture_route", path }, 501);
  return nativeFetch(input, init);
};

setActiveVault("primary");
await fetchMe();
useUIStore.setState({ contextPanelOpen: false, sidebarWidth: 260, sidebarOpen: true });
const open = byId(params.get("open") ?? "living");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ createShareLink: async () => "", ...(extension?.sharing ?? {}), ...(params.has("guest") ? { getViewer: async () => ({ email: "guest@example.test", role: "guest" as const, isServerOwner: false, vaultId: "primary" }) } : {}) }}>
    <App skipOnboarding initialTab={open ? { id: open.id, title: pageTitle(open.path), type: "document" } : undefined} />
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
