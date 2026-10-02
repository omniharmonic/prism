/** Real shared workspace, fictional data. Never connects to a live server. */
import React from "react";
import { createRoot } from "react-dom/client";
import { App, PageHeader, CollabSharingProvider, VaultClientProvider, PlatformProvider, useUIStore, type Note } from "@prism/core";
import { navigateWikilink } from "../../../packages/core/src/lib/wikilinkNavigation";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";

const date = "2026-10-01T12:00:00.000Z";
const notes: Note[] = [
  { id: "workspace", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A shared place to think, write, and build with the same context.</p><h2>Principles</h2><p>Your notes remain yours. Ideas connect across conversations, documents, and the people behind them.</p><ul><li>Context stays connected.</li><li>Changes are reviewable.</li><li>Collaboration feels natural.</li></ul><h2>Next steps</h2><p>Bring the document and its conversation into one comfortable workspace.</p>", tags: ["project"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "field-notes", path: "Projects/Prism/Field notes", content: "<h1>Field notes</h1><p>Useful observations from our last conversation.</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "weekly-review", path: "Journal/Weekly review", content: "<h1>Weekly review</h1><p>What moved forward this week?</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
];
const writes: Array<Record<string, unknown>> = [];
const controls = { rejectWrite: false };
Object.assign(window, { prismFixtureWrites: writes, prismFixtureControls: controls, prismFixtureOpenLink: () => navigateWikilink(httpVaultClient, "Duplicate", note => useUIStore.getState().openTab(note.id, note.path!, "document")) });
notes.push({ id: "thread", path: "Messages/Project discussion", content: "# Project discussion\n\n[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:20] Alex: Another thought.", tags: ["message-thread"], metadata: { type: "message-thread", platform: "telegram" }, createdAt: date, updatedAt: date });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/auth/me") return Response.json({ authenticated: true, email: "owner@example.test", name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/wikilinks/resolve") return Response.json({ kind: "ambiguous", candidates: notes.slice(1,3).map(n => ({ id: n.id, path: n.path, title: "Duplicate" })) });
  if (path === "/api/tree") return Response.json(notes.map((n) => ({ ...n, content: undefined, type: "document" })));
  if (path === "/api/notes" && method === "GET") return Response.json(notes.filter((n) => !url.searchParams.has("tag") || n.tags?.includes(url.searchParams.get("tag")!)));
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      if (controls.rejectWrite) return Response.json({ error: "fixture_write_denied" }, { status: 403 });
      Object.assign(note, body, { metadata: { ...note.metadata, ...body.metadata }, updatedAt: new Date().toISOString() });
    }
    return Response.json(note);
  }
  if (path === "/api/tags") return Response.json([{ name: "project", count: 1 }, { name: "note", count: 2 }]);
  if (path === "/api/vault" || path === "/api/vault/info") return Response.json({ name: "Personal vault", description: "A place for connected ideas.", stats: { totalNotes: notes.length, totalTags: 2, totalLinks: 0 } });
  if (path === "/api/vault/stats" || path === "/api/stats") return Response.json({ totalNotes: notes.length, totalTags: 2, totalLinks: 0 });
  if (path === "/api/graph") return Response.json({ nodes: notes.map((n) => ({ id: n.id, path: n.path, tags: n.tags })), edges: [] });
  if (path === "/api/paths") return Response.json(["Projects", "Journal"]);
  if (path.startsWith("/api/") || path.startsWith("/acl/") || path.startsWith("/auth/")) return Response.json({ error: "unsupported_fixture_route", path }, { status: 501 });
  return nativeFetch(input, init);
};
setActiveVault("primary");
await fetchMe();
useUIStore.setState({ contextPanelOpen: true, contextPanelTab: "agent", sidebarWidth: 240, contextPanelWidth: 360 });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ createShareLink: async () => "", getAccess: async () => ({ note: { id: "workspace", title: "A living workspace", tags: [], visibility: "private" }, people: [], links: [], tagAccess: [], canManageLinks: true, allowedLevels: ["view", "comment", "suggest", "edit"] }) }}>
    {location.search.includes("header") ? <div style={{ padding: 24 }}><PageHeader path="_test/prism-native-workspace-20261001" right={<div className="flex items-center gap-3"><span>Live · Editing</span><span>Two people</span><button>Comments</button></div>} /></div> : <App skipOnboarding initialTab={location.search.includes("thread") ? { id: "thread", title: "Project discussion", type: "message-thread" } : { id: "workspace", title: "A living workspace", type: "document" }} />}
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></React.StrictMode>,
);
