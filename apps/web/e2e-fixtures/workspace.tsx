/** Real shared workspace, fictional data. Never connects to a live server. */
import React from "react";
import { createRoot } from "react-dom/client";
import { AgentClientProvider, App, InvalidationSourceProvider, PageHeader, CollabSharingProvider, VaultClientProvider, PlatformProvider, useUIStore, type Note } from "@prism/core";
import { navigateWikilink } from "../../../packages/core/src/lib/wikilinkNavigation";
import { httpVaultClient } from "../src/parachute/HttpVaultClient";
import { fetchMe, confirmAudience, setActiveVault, getActiveVault, agentScope } from "../src/config";

import { replyAgent } from "./reply-agent";

import type { InvalidationHandlers, InvalidationSource } from "../../../packages/core/src/lib/events/invalidation";
import { fakeMove } from "./fake-move";
import { queryTerms, searchMatches } from "@prism/core/search";
let eventHandlers: InvalidationHandlers | null = null;
const eventSource: InvalidationSource = { open(handlers) { eventHandlers = handlers; handlers.onOpen(); return () => { if (eventHandlers === handlers) eventHandlers = null; }; } };
Object.assign(window, { prismFixtureInvalidate: (id: string, tree = false) => eventHandlers?.onEvent(tree ? { type: "note", id, op: "upsert", tree: true } : { type: "note", id, op: "upsert" }) });
const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const readGates = new Map<string, () => void>();
const reads: string[] = [];
const date = "2026-10-01T12:00:00.000Z";
const notes: Note[] = [
  { id: "workspace", path: "Projects/Prism/A living workspace", content: "<h2>Purpose</h2><p>A shared place to think, write, and build with the same context.</p><h2>Principles</h2><p>Your notes remain yours. Ideas connect across conversations, documents, and the people behind them.</p><ul><li>Context stays connected.</li><li>Changes are reviewable.</li><li>Collaboration feels natural.</li></ul><h2>Next steps</h2><p>Bring the document and its conversation into one comfortable workspace.</p>", tags: ["project"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "field-notes", path: "Projects/Prism/Field notes", content: "<h1>Field notes</h1><p>Useful observations from our last conversation.</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "weekly-review", path: "Journal/Weekly review", content: "<h1>Weekly review</h1><p>What moved forward this week?</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
];
const writes: Array<Record<string, unknown>> = [];
const controls = { noteStatus: {} as Record<string, number>, rejectWriteStatus: 403, actor: "owner@example.test", rejectWrite: false, peopleFail: false, peopleDenyOpen: false, peopleHold: false, peopleRelease: null as (() => void) | null,
  /** Hold the next identity checks (`/auth/me`) until `meRelease()` — a slow account check after a vault switch. */
  meHold: false, meRelease: null as (() => void) | null };
Object.assign(window, {
  prismFixtureUI: useUIStore,
  prismFixtureReads: reads,
  prismFixtureReleaseRead: (id: string) => { readGates.get(id)?.(); readGates.delete(id); },
  prismFixtureSwitchActor: async (email: string) => { controls.actor = email; await fetchMe(); },
  prismFixtureSwitchVault: async (id: string) => { setActiveVault(id); window.dispatchEvent(new Event("prism:vault-changed")); await fetchMe(); },
  prismFixtureWrites: writes, prismFixtureControls: controls, prismFixtureNotes: notes, prismFixtureOpenLink: () => navigateWikilink(httpVaultClient, "Duplicate", note => useUIStore.getState().openTab(note.id, note.path!, "document")) });
notes.push({ id: "thread", path: "Messages/Project discussion", content: "# Project discussion\n\n[2026-10-01 10:15] @morgan:example.test: First line\nSecond line\n\n- A list\n[2026-10-01 10:20] Alex: Another thought.", tags: ["message-thread"], metadata: { type: "message-thread", platform: "telegram", ...(params.has("live") ? { matrixRoomId: "!fixture:example.test" } : {}) }, createdAt: date, updatedAt: date });
if (params.has("canvas")) notes.push({ id: "focus-canvas", path: "Projects/Prism/Canvas fixture", content: JSON.stringify({ elements: [], appState: {} }), metadata: { type: "canvas" }, tags: ["canvas"], createdAt: date, updatedAt: date });
const fixturePeople = [
      { updatedAt: date, canManageIdentities: !location.search.includes("people-readonly"), id: "person-a", name: "Alex Morgan", path: "People/Alex Morgan A", role: "Designer", identities: [{ kind: "email", value: "alex.design@example.test" }] },
      { updatedAt: date, canManageIdentities: !location.search.includes("people-readonly"), id: "person-b", name: "Alex Morgan", path: "People/Alex Morgan B", role: "Engineer", identities: [{ kind: "email", value: "alex.engineering@example.test" }] },
    ];

let identityRevision=0;
/** `?vaultdata` (NP-SB-01): the second vault holds DIFFERENT pages, the sidebar's switch is the
 *  real one (apps/web/src/collab/grant.ts), and every page-data request is logged with its vault. */
const researchNotes: Note[] = [
  { id: "study", path: "Studies/Tidepool study", content: "<p>Observations from the tidepool survey.</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
  { id: "methods", path: "Studies/Methods", content: "<p>How the survey was carried out.</p>", tags: ["note"], metadata: { type: "document" }, createdAt: date, updatedAt: date },
];
const vaultRequests: Array<{ path: string; vault: string | null }> = [];
Object.assign(window, { prismFixtureVaultRequests: vaultRequests });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) return Response.json({ error: "external_network_disabled_in_fixture" }, { status: 503 });
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/api/people" || path.startsWith("/api/people/")) {
    if (controls.peopleHold) await new Promise<void>(resolve => { controls.peopleRelease = resolve; });
    if (controls.peopleFail) return Response.json({ error: "unavailable" }, { status: 503 });
    const people = fixturePeople;
    if (path === "/api/people") {
      const q=(url.searchParams.get("q")||"").toLowerCase();
      return Response.json({people:people.filter(p=>JSON.stringify(p).toLowerCase().includes(q)),next:null});
    }
    if (path.endsWith("/identities") && method === "POST") {
      const person=people.find(p=>p.id===path.split("/").at(-2));
      if(!person)return Response.json({error:"not_found"},{status:404});
      const change=JSON.parse(String(init?.body));
      writes.push(change);
      if(controls.rejectWrite || change.ifUpdatedAt!==person.updatedAt)return Response.json({error:"conflict"},{status:409});
      person.identities = change.action === "remove" ? person.identities.filter(i=>i.value!==change.value) : [...person.identities,{kind:change.kind,value:change.value.toLowerCase()}];
      person.updatedAt="identity-"+(++identityRevision);
      return Response.json({person});
    }
    const person=people.find(p=>p.id===path.split("/").at(-1));
    if(!person)return Response.json({error:"not_found"},{status:404});
    return Response.json({ person, related: [{id:"field-notes",title:"Project conversation",path:"Projects/Prism/Field notes",category:"conversations",relationships:["email_from"]},{id:"weekly-review",title:"Weekly planning",path:"Journal/Weekly review",category:"meetings",relationships:["attendee"]}], next:null });
  }
  if (params.has("vaultdata") && path.startsWith("/api/")) {
    const vault = new Headers(init?.headers).get("X-Prism-Vault");
    vaultRequests.push({ path: path + url.search, vault });
    const set = vault === "secondary" ? researchNotes : notes;
    if (path === "/api/search") {
      const terms = queryTerms(url.searchParams.get("q") ?? "");
      return Response.json(set.filter((n) => terms.every((t) => (n.path + " " + n.content).toLowerCase().includes(t))).map((n) => ({ ...n, content: undefined, _matches: searchMatches(n, terms) })));
    }
    if (vault === "secondary") {
      if (path === "/api/tree") return Response.json(set.map((n) => ({ ...n, content: undefined, type: "document" })));
      if (path === "/api/notes" && method === "GET") return Response.json(set);
      const one = method === "GET" ? path.match(/^\/api\/notes\/([^/]+)$/)?.[1] : undefined;
      if (one) { const hit = set.find((n) => n.id === decodeURIComponent(one)); return hit ? Response.json(hit) : Response.json({ error: "not_found" }, { status: 404 }); }
    }
  }
  if (path === "/auth/me" && controls.meHold) await new Promise<void>((resolve) => { const earlier = controls.meRelease; controls.meRelease = () => { earlier?.(); resolve(); }; });
  if (path === "/auth/me") return Response.json({ authenticated: true, email: controls.actor, name: "You", isOwner: true, vaultId: getActiveVault() ?? "primary", workspace: { id: "default", name: "Personal workspace" } });
  if (path === "/api/threads/thread/live") return Response.json({ messages: [{ event_id: "$fixture", sender: "@fixture:example.test", sender_name: "Fixture", body: "LIVE_RESPONSIVE_THREAD_FIXTURE", timestamp: Date.UTC(2026, 9, 1), is_outgoing: false, msg_type: "m.text", media_url: null, media_info: null }], start: null, end: null, has_more: false });
  if (path === "/api/wikilinks/resolve") return Response.json({ kind: "ambiguous", candidates: notes.slice(1,3).map(n => ({ id: n.id, path: n.path, title: "Duplicate" })) });
  if (path === "/api/tree") return Response.json(notes.map((n) => ({ ...n, content: undefined, type: "document" })));
  if (path === "/api/notes" && method === "GET") return Response.json(notes.filter((n) => !url.searchParams.has("tag") || n.tags?.includes(url.searchParams.get("tag")!)));
  if (path === "/api/notes" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    if (controls.rejectWrite) return Response.json({ error: "fixture_write_denied" }, { status: controls.rejectWriteStatus });
    const note: Note = { id: `created-${notes.length}`, content: " ", metadata: {}, tags: [], ...body, createdAt: date, updatedAt: date };
    notes.push(note);
    return Response.json(note);
  }
  const moveOf = method === "POST" ? path.match(/^\/api\/notes\/([^/]+)\/move$/)?.[1] : undefined;
  if (moveOf) {
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    if (controls.rejectWrite) return Response.json({ error: "fixture_write_denied" }, { status: controls.rejectWriteStatus });
    const moved = fakeMove(notes, decodeURIComponent(moveOf), body, () => new Date().toISOString());
    return Response.json(moved.body, { status: moved.status });
  }
  const noteId = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
  if (noteId) {
    if (method === "GET") {
      reads.push(noteId);
      if (controls.noteStatus[noteId]) return Response.json({ error: "fixture_note_failure" }, { status: controls.noteStatus[noteId] });
      if (params.get("unavailable") === noteId) throw new TypeError("Fixture network unavailable");
      if (params.get("hold") === noteId) await new Promise<void>(resolve => readGates.set(noteId, resolve));
      if (params.get("deny") === noteId) return Response.json({error:"forbidden"},{status:403});
    }
    if (params.has("account-isolation") && controls.actor === "second@example.test" && noteId === "field-notes") return Response.json({ error: "forbidden" }, { status: 403 });
    if(controls.peopleDenyOpen && noteId === "field-notes") return Response.json({error:"forbidden"},{status:403});
    const note = notes.find((n) => n.id === noteId);
    if (!note) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      if (controls.rejectWrite) return Response.json({ error: "fixture_write_denied" }, { status: controls.rejectWriteStatus });
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
const agent = params.has("agent") ? replyAgent(() => agentScope() ?? "") : null;
useUIStore.setState({ contextPanelOpen: true, contextPanelTab: "agent", sidebarWidth: 240, contextPanelWidth: 360 });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AgentClientProvider client={agent}><InvalidationSourceProvider source={params.has("events") ? eventSource : null}><PlatformProvider value="web"><VaultClientProvider client={httpVaultClient}><CollabSharingProvider value={{ ...(params.has("navigation") ? {
      listVaults: async () => { const chosen = params.has("vaultdata") ? getActiveVault() ?? "primary" : "primary"; return [{ id: "primary", label: "Personal vault", vault: "personal", active: chosen === "primary" }, { id: "secondary", label: "Shared research", vault: "research", active: chosen === "secondary" }]; },
      getActiveVault: () => params.has("vaultdata") ? getActiveVault() ?? "primary" : "primary",
      setActiveVault: (id: string) => {
        writes.push({ switchedVault: id });
        if (!params.has("vaultdata")) return;
        setActiveVault(id);
        window.dispatchEvent(new CustomEvent("prism:vault-changed", { detail: id }));
        void confirmAudience(); // what main.tsx does on this event
      },
      listWorkspaceEntities: async () => [{ id: "default", name: "Personal workspace", hostname: null, isDefault: true, vaults: [{ id: "primary", label: "Personal vault", vault: "personal" }] }],
      setActiveWorkspace: (id: string) => { writes.push({ switchedWorkspace: id }); },
    } : {}), createShareLink: async () => "", getAccess: async () => ({ note: { id: "workspace", title: "A living workspace", tags: [], visibility: "private" }, people: [], links: [], tagAccess: [], canManageLinks: true, allowedLevels: ["view", "comment", "suggest", "edit"] }) }}>
    {location.search.includes("header") ? <div style={{ padding: 24 }}><PageHeader path="_test/prism-native-workspace-20261001" right={<div className="flex items-center gap-3"><span>Live · Editing</span><span>Two people</span><button>Comments</button></div>} /></div> : <App skipOnboarding initialTab={params.has("session") ? undefined : location.search.includes("people") ? { id: "people", title: "People", type: "people" as any } : location.search.includes("thread") ? { id: "thread", title: "Project discussion", type: "message-thread" } : { id: "workspace", title: "A living workspace", type: "document" }} />}
  </CollabSharingProvider></VaultClientProvider></PlatformProvider></InvalidationSourceProvider></AgentClientProvider></React.StrictMode>,
);
