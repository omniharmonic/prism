/** Real shared workspace, fictional data. Never connects to a live server. */
import React from "react";
import { createRoot } from "react-dom/client";
import { App, VaultClientProvider, PlatformProvider, useUIStore, type Note } from "@prism/core";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, setActiveVault } from "../src/config";

const date = "2026-10-01T12:00:00.000Z";
const notes: Note[] = [
  { id: "workspace", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A shared place to think, write, and build with the same context.</p><h2>Principles</h2><p>Your notes remain yours. Ideas connect across conversations, documents, and the people behind them.</p><ul><li>Context stays connected.</li><li>Changes are reviewable.</li><li>Collaboration feels natural.</li></ul><h2>Next steps</h2><p>Bring the document and its conversation into one comfortable workspace.</p>", tags: ["project"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "field-notes", path: "Projects/Prism/Field notes", content: "<h1>Field notes</h1><p>Useful observations from our last conversation.</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "weekly-review", path: "Journal/Weekly review", content: "<h1>Weekly review</h1><p>What moved forward this week?</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
];
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/auth/me") return Response.json({ authenticated: true, email: "owner@example.test", name: "You", isOwner: true, vaultId: "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/tree") return Response.json(notes.map((n) => ({ ...n, content: undefined, type: "document" })));
  if (path === "/api/notes" && method === "GET") return Response.json(notes.filter((n) => !url.searchParams.has("tag") || n.tags?.includes(url.searchParams.get("tag")!)));
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "PATCH") Object.assign(note, JSON.parse(String(init?.body)), { updatedAt: new Date().toISOString() });
    return Response.json(note);
  }
  if (path === "/api/tags") return Response.json([{ name: "project", count: 1 }, { name: "note", count: 2 }]);
  if (path === "/api/vault" || path === "/api/vault/info") return Response.json({ name: "Personal vault", description: "A place for connected ideas." });
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
  <React.StrictMode><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}>
    <App skipOnboarding initialTab={{ id: "workspace", title: "A living workspace", type: "document" }} />
  </VaultClientProvider></PlatformProvider></React.StrictMode>,
);
