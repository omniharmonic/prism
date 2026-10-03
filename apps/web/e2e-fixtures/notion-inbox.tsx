/**
 * Inbox, Home and request-access fixture (wave 2A): the real shared workspace
 * over an in-page fake of the Prism Server notifications / reminders /
 * access-request API (the wire contract in packages/core/src/lib/notifications/client.ts).
 * Fictional data; never connects to a live server.
 *
 * State that must survive a reload or be shared between the owner's and the
 * member's page (read/archived state, settings, access requests, grants) lives in
 * localStorage "fixture-inbox"; `?reset` clears it.
 *
 * Query flags: ?as=owner|member · ?open=<id|notifications|home> · ?reset ·
 * ?notification=<id> (push deep link) · ?theme=dark · ?no-push (server has no push). "Start with last open document" off
 * is set by the spec via addInitScript (the settings store hydrates when
 * @prism/core is imported, before this module runs).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App, PlatformProvider, VaultClientProvider, CollabSharingProvider, useUIStore, setPendingNotification, type Note } from "@prism/core";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";

const params = new URLSearchParams(location.search);
const as = params.get("as") === "member" ? "member" : "owner";
const me = as === "owner" ? { email: "owner@example.test", name: "Robin Vale" } : { email: "sam@example.test", name: "Sam Ortiz" };
if (params.has("reset")) localStorage.removeItem("fixture-inbox");

const NOW = Date.now();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
// Local noon tomorrow: "NOW + 26h" is the day after tomorrow once it is past 22:00, which made the Home test time-of-day dependent.
const TOMORROW_NOON = (() => { const d = new Date(NOW); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const doc = (id: string, path: string, html: string, extra: Partial<Note> = {}): Note => ({
  id, path, content: html, tags: ["page"], metadata: { type: "document" }, createdAt: iso(NOW - 10 * DAY), updatedAt: iso(NOW - DAY), ...extra,
});
const notes: Note[] = [
  doc("roadmap", "vault/Projects/Roadmap", '<h2>Q4 goals</h2><p>Ship the inbox. <span data-type="mention" data-kind="person" data-id="p-robin" data-label="Robin Vale" data-mention-uid="m1">@Robin Vale</span> owns the launch review.</p>'),
  doc("launch", "vault/Projects/Launch plan", '<p>Draft the <span data-comment-id="t1" data-resolved="false">announcement copy</span> by Friday.</p>'),
  doc("field", "vault/Notes/Field notes", "<p>River survey, upper reach.</p>"),
  doc("secret", "vault/Finance/Budget 2027", "<p>Confidential numbers.</p>", { metadata: { type: "document", prism_creator: "owner@example.test" } }),
  doc("task-1", "vault/tasks/Write release notes", "<p>For the inbox release.</p>", { tags: ["task"], metadata: { type: "task", status: "in-progress", due: iso(NOW + DAY).slice(0, 10), assigned: "You" } }),
  doc("task-2", "vault/tasks/Review access requests", "<p>Weekly.</p>", { tags: ["task"], metadata: { type: "task", status: "todo", assigned: "You, Ada Park" } }),
  doc("task-3", "vault/tasks/Old cleanup", "<p>Done.</p>", { tags: ["task"], metadata: { type: "task", status: "done", assigned: "You" } }),
  // Someone else's open task: visible to the viewer, but not one of THEIR tasks (wave 3).
  doc("task-4", "vault/tasks/Order catering", "<p>For Ada.</p>", { tags: ["task"], metadata: { type: "task", status: "todo", assigned: "Ada Park" } }),
  doc("meet-1", "vault/meetings/Design sync", "<p>Agenda.</p>", { tags: ["meeting"], metadata: { type: "meeting", title: "Design sync", start: iso(TOMORROW_NOON), end: iso(TOMORROW_NOON + 3_600_000) } }),
  doc("meet-2", "vault/meetings/Old retro", "<p>Past.</p>", { tags: ["meeting"], metadata: { type: "meeting", title: "Old retro", start: iso(NOW - 3 * DAY), end: iso(NOW - 3 * DAY + HOUR) } }),
];

type Item = {
  id: string; type: string; noteId: string | null; title?: string | null; actor: { name: string } | null;
  anchor: Record<string, string> | null; preview: string | null; requestId?: string | null;
  createdAt: number; readAt: number | null; archivedAt: number | null; to: "owner" | "member";
};
type State = {
  items: Item[];
  settings: Record<string, { push: boolean; email: boolean }>;
  requests: Array<{ id: string; noteId: string; level: string; requester: { name: string; email: string }; message: string | null; createdAt: number; status: string; decided?: string }>;
  grants: Record<string, string>;
};
const initial = (): State => ({
  items: [
    { id: "n1", type: "mention", noteId: "roadmap", actor: { name: "Ada Park" }, anchor: { mention: "m1" }, preview: null, createdAt: NOW - 20 * MIN, readAt: null, archivedAt: null, to: "owner" },
    { id: "n2", type: "comment_reply", noteId: "launch", actor: { name: "Lee Chen" }, anchor: { thread: "t1" }, preview: "Agreed — I’ll take the first pass at the copy.", createdAt: NOW - 2 * HOUR, readAt: null, archivedAt: null, to: "owner" },
    { id: "n3", type: "share", noteId: "field", actor: { name: "Ada Park" }, anchor: null, preview: null, createdAt: NOW - DAY - HOUR, readAt: NOW - DAY, archivedAt: null, to: "owner" },
    { id: "n4", type: "reminder", noteId: "roadmap", actor: null, anchor: { reminder: "r-old" }, preview: null, createdAt: NOW - 5 * DAY, readAt: NOW - 4 * DAY, archivedAt: null, to: "owner" },
    { id: "n5", type: "comment_mention", noteId: "launch", actor: { name: "Lee Chen" }, anchor: { thread: "t1" }, preview: "@Robin Vale can you sign off?", createdAt: NOW - 6 * DAY, readAt: NOW - 6 * DAY, archivedAt: NOW - 5 * DAY, to: "owner" },
  ],
  settings: { mention: { push: true, email: true }, comment: { push: true, email: false }, reminder: { push: true, email: false }, access: { push: true, email: true } },
  requests: [],
  grants: {},
});
const load = (): State => { try { return JSON.parse(localStorage.getItem("fixture-inbox") ?? "") as State; } catch { return initial(); } };
let state = load();
const save = () => localStorage.setItem("fixture-inbox", JSON.stringify(state));
save();
const writes: Array<Record<string, unknown>> = [];
Object.assign(window, { prismFixtureUI: useUIStore, prismFixtureWrites: writes, prismFixtureState: () => state });

const json = (body: unknown, status = 200) => Response.json(body, { status });
const byId = (id: string) => notes.find((n) => n.id === id);
const title = (n: Note) => n.path!.split("/").pop()!;
/** The member may view everything except the owner's budget page — unless a grant says so. */
const canView = (n: Note) => as === "owner" || n.id !== "secret" || !!state.grants[`${me.email}:${n.id}`];
const mine = () => state.items.filter((i) => i.to === as);
const view = (i: Item) => ({ ...i, title: i.noteId ? title(byId(i.noteId)!) : null, to: undefined });
const unread = () => mine().filter((i) => !i.readAt && !i.archivedAt).length;

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return json({ error: "external_network_disabled_in_fixture" }, 503);
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};
  state = load();
  if (path === "/auth/me") return json({ authenticated: true, email: me.email, name: me.name, isOwner: as === "owner", role: as === "owner" ? "owner" : "member", vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/tree") return json(notes.filter(canView).map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type })));
  if (path === "/api/me/preferences") {
    const recents = ["roadmap", "launch", "field"].filter((id) => canView(byId(id)!));
    const items: Record<string, unknown> = {};
    for (const id of recents) { const n = byId(id)!; items[id] = { path: n.path, title: title(n), tags: n.tags, type: "document" }; }
    return json({ preferences: { version: 1, favorites: [], recents, sidebar: { order: [], collapsed: [] } }, revision: 1, items });
  }

  // ── notifications ──
  if (path === "/api/notifications/unread") return json({ unread: unread() });
  if (path === "/api/notifications" && method === "GET") {
    const box = url.searchParams.get("box") ?? "inbox";
    const type = url.searchParams.get("type");
    const items = mine().filter((i) => (box === "archived" ? !!i.archivedAt : !i.archivedAt) && (!type || i.type === type) && (!i.noteId || canView(byId(i.noteId)!)))
      .sort((a, b) => b.createdAt - a.createdAt).map(view);
    return json({ items, next: null, unread: unread() });
  }
  if (path === "/api/notifications/read" && method === "POST") {
    writes.push({ read: body });
    for (const i of mine()) if (body.all || (body.ids ?? []).includes(i.id)) i.readAt ??= Date.now();
    save();
    return json({ ok: true, unread: unread() });
  }
  if (path === "/api/notifications/archive" && method === "POST") {
    writes.push({ archive: body });
    for (const i of mine()) if ((body.ids ?? []).includes(i.id)) { i.archivedAt = body.archived ? Date.now() : null; i.readAt ??= Date.now(); }
    save();
    return json({ ok: true, unread: unread() });
  }
  if (path === "/api/notifications/settings") {
    if (method === "PUT") { writes.push({ settings: body.settings }); state.settings = body.settings; save(); }
    return json({ settings: state.settings, available: { webPush: !params.has("no-push"), apns: false, email: true } });
  }
  if (path === "/api/reminders" && method === "GET") {
    return json({ items: [{ id: "r1", noteId: "roadmap", title: "Roadmap", at: NOW + 3 * HOUR, tz: "UTC", dateOnly: false, uid: "m1", status: "scheduled" }] });
  }

  // ── access requests ──
  if (path === "/api/access-requests" && method === "POST") {
    writes.push({ requestAccess: body });
    if (as === "member" && byId(body.noteId) && !state.requests.some((r) => r.noteId === body.noteId && r.status === "pending")) {
      const id = `req-${state.requests.length + 1}`;
      state.requests.push({ id, noteId: body.noteId, level: body.level ?? "view", requester: { name: me.name, email: me.email }, message: null, createdAt: Date.now(), status: "pending" });
      state.items.push({ id: `n-${id}`, type: "access_request", noteId: body.noteId, actor: { name: me.name }, anchor: null, preview: null, requestId: id, createdAt: Date.now(), readAt: null, archivedAt: null, to: "owner" });
      save();
    }
    return json({ ok: true }, 202);
  }
  if (path === "/api/access-requests" && method === "GET") {
    if (as !== "owner") return json({ items: [] });
    return json({ items: state.requests.map((r) => ({ ...r, title: title(byId(r.noteId)!) })) });
  }
  const decide = path.match(/^\/api\/access-requests\/([^/]+)$/);
  if (decide && method === "POST") {
    writes.push({ decide: decide[1], ...body });
    const r = state.requests.find((x) => x.id === decide[1]);
    if (!r || as !== "owner") return json({ error: "not_found" }, 404);
    if (r.status !== "pending") return json({ error: "already_decided" }, 409);
    r.status = body.decision === "approve" ? "approved" : "denied";
    if (r.status === "approved") state.grants[`${r.requester.email}:${r.noteId}`] = body.level ?? "view";
    state.items.push({ id: `n-out-${r.id}`, type: r.status === "approved" ? "access_granted" : "access_denied", noteId: r.noteId, actor: null, anchor: null, preview: null, createdAt: Date.now(), readAt: null, archivedAt: null, to: "member" });
    save();
    return json({ ok: true, status: r.status });
  }

  // ── vault reads ──
  // My tasks (wave 3): the server narrows to the caller's own tasks. `?oldserver`
  // answers like a server that predates `assignedToMe` (no `identity`).
  if (path === "/api/query" && method === "POST") {
    const mine = body.assignedToMe === true && !params.has("oldserver");
    const rows = notes.filter((n) => canView(n) && (body.tags as string[]).every((t) => n.tags?.includes(t)))
      .filter((n) => !mine || String(n.metadata?.assigned ?? "").split(",").map((v) => v.trim()).includes("You"))
      .map((n) => ({ id: n.id, path: n.path, tags: n.tags, createdAt: n.createdAt, updatedAt: n.updatedAt, metadata: n.metadata }));
    (window as unknown as { prismQueries?: unknown[] }).prismQueries = [...((window as unknown as { prismQueries?: unknown[] }).prismQueries ?? []), body];
    return json({ rows, next: null, total: rows.length, limited: false, truncated: false, ...(mine ? { identity: params.has("noperson") ? "account" : "person" } : {}) });
  }
  if (path === "/api/notes" && method === "GET") {
    const tag = url.searchParams.get("tag");
    return json(notes.filter((n) => canView(n) && (!tag || n.tags?.includes(tag))));
  }
  const one = path.match(/^\/api\/notes\/([^/]+)$/);
  if (one) {
    const note = byId(decodeURIComponent(one[1]!));
    if (!note || !canView(note)) return json({ error: "forbidden" }, as === "member" ? 403 : 404);
    if (method === "PATCH") { writes.push({ patch: note.id, ...body }); if (typeof body.content === "string") note.content = body.content; note.updatedAt = iso(Date.now()); }
    return json(as === "member" ? { ...note, _caps: ["view", "comment"] } : note);
  }
  if (path.match(/^\/api\/notes\/[^/]+\/versions$/)) return json({ versions: [], total: 0 });
  if (path.match(/^\/api\/notes\/[^/]+\/links/)) return json([]);
  if (path === "/api/tags") return json([{ name: "page", count: 4 }, { name: "task", count: 3 }]);
  if (path === "/api/vault" || path === "/api/vault/info") return json({ name: "Personal vault", description: "", stats: { totalNotes: notes.length, totalTags: 3, totalLinks: 0 } });
  if (path === "/api/vault/stats" || path === "/api/stats") return json({ totalNotes: notes.length, totalTags: 3, totalLinks: 0 });
  if (path.startsWith("/api/") || path.startsWith("/acl/") || path.startsWith("/auth/")) return json({ error: "unsupported_fixture_route", path }, 501);
  return nativeFetch(input, init);
};

// ?notification=<id> = the push deep link /inbox/<id> (main.tsx does the same).
if (params.get("notification")) setPendingNotification(params.get("notification"));
setActiveVault("primary");
await fetchMe();
useUIStore.setState({ contextPanelOpen: false, sidebarWidth: 260, sidebarOpen: true });
const openId = params.get("open");
const initialTab = openId === "notifications" ? { id: "notifications", title: "Inbox", type: "notifications" }
  : openId === "home" ? { id: "home", title: "Home", type: "home" }
  : openId && byId(openId) ? { id: openId, title: title(byId(openId)!), type: "document" } : undefined;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ createShareLink: async () => "" }}>
    <App skipOnboarding initialTab={initialTab} />
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
const theme = () => { if (params.get("theme") === "dark") { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); } };
theme();
setTimeout(theme, 50);
