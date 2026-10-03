/**
 * Mentions fixture (NP-RF-02…07, CO-01): the real workspace (plain document
 * editor) over an in-page fake of the Prism Server — notes, people, reminders,
 * notifications and note links. Fictional data; never connects to a live server.
 *
 * The fake server derives `mentions` links from saved content with the SAME pure
 * parser the server uses (`extractMentions`), and turns a reminder into an inbox
 * item once the (Playwright-controlled) clock passes its time.
 *
 * Query flags: ?open=<id> initial page · ?comments → the live editor + comments
 * sidebar on a local Y.Doc (comment mentions, edit own, resolve / reopen).
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, PlatformProvider, VaultClientProvider, CollabSharingProvider, CollabEditor, CommentsSidebar, useUIStore, type Note, type Editor } from "@prism/core";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";
import { extractMentions } from "../../../packages/core/src/lib/tiptap/MentionParse";
import { TRASH_TAG } from "../../../packages/core/src/lib/pages/model";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";
import "../../../packages/core/src/styles/collab.css";

const params = new URLSearchParams(location.search);
let tick = Date.UTC(2026, 9, 1, 12);
const stamp = () => new Date((tick += 1000)).toISOString();
const chip = (attrs: Record<string, string>) =>
  `<span data-type="mention" ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}>@x</span>`;
const doc = (id: string, path: string, html: string, extra: Partial<Note> = {}): Note => ({
  id, path, content: html, tags: ["page"], metadata: { type: "document" }, createdAt: stamp(), updatedAt: stamp(), ...extra,
});
const notes: Note[] = [
  doc("plan", "vault/Projects/Launch plan", "<p>Write the plan here.</p>"),
  doc("brief", "vault/Projects/Project brief", "<p>The brief for the spring launch: goals, scope and milestones.</p>", { metadata: { type: "document", icon: "🧭" } }),
  doc("retro", "vault/Projects/Retro notes", "<p>What went well.</p>"),
  doc("old", "vault/Archive/Old draft", "<p>Gone.</p>", { tags: ["page", TRASH_TAG] }),
  doc("secret", "vault/Private/Salary review", "<p>Confidential.</p>"),
  doc("refs", "vault/Projects/References", `<p>See ${chip({ "data-kind": "page", "data-id": "brief", "data-mention-uid": "u-brief" })} and ${chip({ "data-kind": "page", "data-id": "secret", "data-mention-uid": "u-secret" })} and ${chip({ "data-kind": "page", "data-id": "old", "data-mention-uid": "u-old" })}.</p><p>Owner ${chip({ "data-kind": "person", "data-id": "p-ada", "data-label": "Ada Lovelace", "data-mention-uid": "u-ada" })} due ${chip({ "data-kind": "date", "data-date": "2026-10-02", "data-mention-uid": "u-date" })}.</p>`),
];
/** Notes the fixture viewer may not open (403), and that no list returns. */
const forbidden = new Set(["secret"]);
const people = [
  { id: "p-ada", name: "Ada Lovelace", role: "Research lead", path: "vault/people/Ada Lovelace", identities: [{ kind: "email", value: "ada@example.test" }, { kind: "matrix", value: "@ada:example.test" }] },
  { id: "p-grace", name: "Grace Hopper", role: "Engineering", path: "vault/people/Grace Hopper", identities: [{ kind: "email", value: "grace@example.test" }] },
];
const writes: Array<Record<string, unknown>> = [];
const reminders: Array<{ id: string; noteId: string; at: number; tz: string; dateOnly: boolean; uid: string | null; status: "scheduled" | "fired" | "cancelled" }> = [];
Object.assign(window, { prismFixtureUI: useUIStore, prismFixtureNotes: notes, prismFixtureWrites: writes, prismFixtureReminders: reminders });

const json = (body: unknown, status = 200) => Response.json(body, { status });
const byId = (id: string) => notes.find((n) => n.id === id || n.path === id);
const visible = () => notes.filter((n) => !forbidden.has(n.id));
const title = (n: Note) => n.path?.split("/").pop() ?? n.id;
function links(id: string) {
  const out: Array<{ sourceId: string; targetId: string; relationship: string; createdAt: string }> = [];
  for (const n of notes) {
    for (const m of extractMentions(n.content)) {
      if ((m.kind === "page" || m.kind === "person") && m.id && (n.id === id || m.id === id)) out.push({ sourceId: n.id, targetId: m.id, relationship: "mentions", createdAt: n.updatedAt ?? undefined });
    }
  }
  return out;
}
/** "At" from the client: date-only fires at 09:00 local, else the instant. */
function fireAt(at: string, dateOnly: boolean): number {
  if (dateOnly) { const [y, m, d] = at.split("-").map(Number); return new Date(y!, m! - 1, d!, 9).getTime(); }
  return new Date(at).getTime();
}
function notificationItems() {
  return reminders.filter((r) => r.status !== "cancelled" && r.at <= Date.now()).map((r) => {
    r.status = "fired";
    const n = byId(r.noteId);
    return { id: `n-${r.id}`, type: "reminder", noteId: r.noteId, title: n ? title(n) : null, actor: null, anchor: { reminder: r.id }, preview: null, createdAt: r.at, readAt: null, archivedAt: null };
  });
}
const reminderOut = (r: (typeof reminders)[number]) => ({ ...r, title: title(byId(r.noteId)!) });

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return json({ error: "external_network_disabled_in_fixture" }, 503);
  const path = url.pathname;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};
  if (path === "/auth/me") return json({ authenticated: true, email: "owner@example.test", name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/tree") return json(visible().map((n) => ({ id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type })));
  if (path === "/api/people") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return json({ people: people.filter((p) => !q || p.name.toLowerCase().includes(q)), next: null });
  }
  const person = path.match(/^\/api\/people\/([^/]+)$/);
  if (person) {
    const p = people.find((x) => x.id === decodeURIComponent(person[1]!));
    return p ? json({ person: p, related: [], next: null }) : json({ error: "not_found" }, 404);
  }
  if (path === "/api/reminders" && method === "GET") return json({ items: reminders.filter((r) => r.status === "scheduled").map(reminderOut) });
  if (path === "/api/reminders" && method === "POST") {
    writes.push({ reminder: body });
    if (!byId(body.noteId)) return json({ error: "not_found" }, 404);
    const r = { id: `r${reminders.length + 1}`, noteId: body.noteId, at: fireAt(body.at, !!body.dateOnly), tz: body.tz, dateOnly: !!body.dateOnly, uid: body.uid ?? null, status: "scheduled" as const };
    reminders.push(r);
    return json({ reminder: reminderOut(r) });
  }
  const reminder = path.match(/^\/api\/reminders\/([^/]+)$/);
  if (reminder) {
    const r = reminders.find((x) => x.id === decodeURIComponent(reminder[1]!));
    if (!r) return json({ error: "not_found" }, 404);
    writes.push({ reminder: r.id, method, ...body });
    if (method === "DELETE") { r.status = "cancelled"; return json({ ok: true }); }
    r.at = fireAt(body.at, !!body.dateOnly);
    r.dateOnly = !!body.dateOnly;
    r.status = "scheduled";
    return json({ reminder: reminderOut(r) });
  }
  if (path === "/api/notifications/unread") return json({ unread: notificationItems().length });
  if (path === "/api/notifications") return json({ items: notificationItems(), next: null, unread: notificationItems().length });
  if (path.startsWith("/api/notifications/")) return json({ ok: true, unread: 0 });
  if (path === "/api/access-requests") return json({ items: [] });
  if (path === "/api/notes" && method === "GET") return json(visible().map((n) => ({ ...n, content: undefined })));
  const one = path.match(/^\/api\/notes\/([^/]+)$/);
  if (one) {
    const id = decodeURIComponent(one[1]!);
    if (forbidden.has(id)) return json({ error: "forbidden" }, 403);
    const note = byId(id);
    if (!note) return json({ error: "not_found" }, 404);
    if (method === "PATCH") {
      writes.push({ patch: note.id, ...body });
      if (typeof body.content === "string") note.content = body.content;
      if (typeof body.path === "string") note.path = body.path;
      if (body.metadata) note.metadata = { ...(note.metadata ?? {}), ...body.metadata };
      note.updatedAt = stamp();
    }
    return json(url.searchParams.get("include_links") ? { ...note, links: links(note.id) } : note);
  }
  if (path.match(/^\/api\/notes\/[^/]+\/versions$/)) return json({ versions: [], total: 0 });
  if (path === "/api/tags") return json([{ name: "page", count: notes.length }]);
  if (path === "/api/vault" || path === "/api/vault/info") return json({ name: "Personal vault", description: "", stats: { totalNotes: notes.length, totalTags: 1, totalLinks: 0 } });
  if (path === "/api/vault/stats" || path === "/api/stats") return json({ totalNotes: notes.length, totalTags: 1, totalLinks: 0 });
  if (path.startsWith("/api/") || path.startsWith("/acl/") || path.startsWith("/auth/")) return json({ error: "unsupported_fixture_route", path }, 501);
  return nativeFetch(input, init);
};

setActiveVault("primary");
await fetchMe();

/** Live editor + comments sidebar on a local Y.Doc (no socket). */
function CommentsFixture() {
  const [ydoc] = useState(() => new Y.Doc());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const user = { name: "You", color: "#6d5bd0" };
  Object.assign(window, {
    prismMentionsFixture: {
      select(text: string) {
        let at = -1;
        editor?.state.doc.descendants((node, pos) => { if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text); });
        if (at < 0) throw new Error("no such text");
        editor!.chain().focus().setTextSelection({ from: at, to: at + text.length }).run();
      },
      comments: () => ydoc.getMap("comments").toJSON(),
    },
  });
  return (
    <div style={{ display: "flex", gap: 24, padding: 24, minHeight: "100vh", background: "var(--bg-base)", color: "var(--text-primary)", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
        <CollabEditor ydoc={ydoc} provider={null} user={user} seedReady seedContent={async () => "<p>The rollout plan is ready for review.</p>"} canComment canReview onEditor={setEditor} onCommentActivate={setFocused} noteId="plan" />
      </div>
      <aside style={{ flex: "0 1 300px" }} aria-label="Comments panel">
        <CommentsSidebar ydoc={ydoc} user={user} canComment editor={editor} focusedThreadId={focused} />
      </aside>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
if (params.has("comments")) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <React.StrictMode><QueryClientProvider client={client}><VaultClientProvider client={httpVaultClient}><CommentsFixture /></VaultClientProvider></QueryClientProvider></React.StrictMode>,
  );
} else {
  useUIStore.setState({ contextPanelOpen: false, sidebarWidth: 260, sidebarOpen: true });
  const open = byId(params.get("open") ?? "plan");
  root.render(
    <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ createShareLink: async () => "" }}>
      <App skipOnboarding initialTab={open ? { id: open.id, title: title(open), type: "document" } : undefined} />
    </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
  );
}
