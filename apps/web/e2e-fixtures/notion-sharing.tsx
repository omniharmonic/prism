/**
 * Fixture for wave 2D standalone components (fictional data, no network):
 *   ?panel=history  HistoryPanel — versions named by writer kind + the Updates feed
 *   ?panel=info     PageInfo — word/character count, created, edited, last editor
 *   ?panel=shared   SharedWithMe (sidebar section); &guest for the guest-only view, &empty
 *   ?panel=move     MoveAccessNotice for a move out of a shared page
 *   &external       (history/info) states written OUTSIDE Prism: stale stamps + the
 *                   owner-visible vault provenance (actor / via) of each change
 * &dark renders the dark theme.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollabSharingProvider, PlatformProvider, VaultClientProvider, type CollabSharing, type Note, type VaultClient } from "@prism/core";
import type { NoteVersion } from "../../../packages/core/src/data/VaultClient";
import type { PageActivity, SharedItem } from "../../../packages/core/src/lib/sharing/types";
import { HistoryPanel } from "../../../packages/core/src/components/layout/HistoryPanel";
import { PageInfo } from "../../../packages/core/src/components/sharing/PageInfo";
import { SharedWithMe } from "../../../packages/core/src/components/sharing/SharedWithMe";
import { MoveAccessNotice } from "../../../packages/core/src/components/sharing/MoveAccessNotice";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import { applyTheme, useSettingsStore } from "../../../packages/core/src/app/stores/settings";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";

const params = new URLSearchParams(location.search);
const dark = params.has("dark");
applyTheme(dark ? "dark" : "light");
useSettingsStore.setState({ theme: dark ? "dark" : "light" });
useAgentChatStore.setState({ scope: "fixture-2d" });
const ME = "u_00000000000000a1"; // opaque writer stamp ids (never emails)
const stamp = (who: string, kind: string, when: string) => ({ prism_last_writer: who, prism_last_write_at: when, prism_last_change: `${kind}@${when}` });
const at = (h: number) => new Date(Date.UTC(2026, 9, 2, h, 0)).toISOString();
const external = params.has("external");

const note: Note = {
  id: "handbook",
  path: "Research/Research handbook",
  content: "<h1>Research handbook</h1><p>A shared workspace where you and your agent work with connected context.</p><p>Prism brings notes, tasks and sources together.</p>",
  // &external: the stamp is two hours older than the note — a write without one (an agent on the vault MCP) came after.
  metadata: stamp(ME, "edit", external ? at(9) : at(11)),
  tags: ["research"],
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: at(11),
};
// Newest first. A row is the state BEFORE a change; its metadata says who wrote that state.
const plainVersions: NoteVersion[] = [
  { versionIx: 4, op: "update", supersededAt: at(11), path: note.path, metadata: stamp(ME, "accepted-suggestion", at(10)), contentLength: 120, content: null },
  { versionIx: 3, op: "update", supersededAt: at(10), path: note.path, metadata: stamp(ME, "agent", at(9)), contentLength: 110, content: null },
  { versionIx: 2, op: "update", supersededAt: at(9), path: note.path, metadata: null, contentLength: 90, content: null, writer: { kind: "person", name: "Sam Chen", self: false } },
  { versionIx: 1, op: "update", supersededAt: at(8), path: note.path, metadata: stamp("link", "edit", at(7)), contentLength: 80, content: null },
  { versionIx: 0, op: "update", supersededAt: at(7), path: note.path, metadata: null, contentLength: 60, content: null },
];
// A row's actor/via describe the change that REPLACED it (owner view only).
const versions: NoteVersion[] = external
  ? plainVersions.map((v) =>
      v.versionIx === 4
        ? { ...v, actor: "agent-session:3f2a9c0b-1111-4222-8333-444455556666", via: "mcp" }
        : v.versionIx === 3
          ? { ...v, metadata: stamp(ME, "edit", at(6)) }
          : v.versionIx === 2
            ? { ...v, writer: undefined, actor: "routine:morning-intel", via: "api" }
            : v,
    )
  : plainVersions;
const activity: PageActivity = {
  comments: [
    {
      noteId: "handbook",
      noteTitle: "Research handbook",
      threadId: "t1",
      quote: "connected context",
      resolved: false,
      lastActivity: Date.parse(at(10)) + 1800_000,
      comments: [
        { author: "Sam Chen", text: "Should this say linked notes?", createdAt: Date.parse(at(10)) + 600_000, agent: false, mine: false },
        { author: "Jordan Diaz", text: "Yes, changing it.", createdAt: Date.parse(at(10)) + 1800_000, agent: false, mine: true },
      ],
    },
  ],
  shares: [{ name: "Morgan Lee", avatar: null, email: "morgan.lee@prism.test", level: "edit", at: Date.parse(at(9)) + 900_000, by: "Jordan Diaz", scope: "page" }],
  sharesVisible: true,
  lastEditor: external ? { kind: "external", name: null, self: false } : { kind: "person", name: "Jordan Diaz", self: true },
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  writers: { [ME]: "Jordan Diaz" },
  me: ME,
};
const shared: SharedItem[] = params.has("empty")
  ? []
  : [
      { id: "plan", title: "Launch plan", path: "Team/Launch plan", scope: "page", level: "edit", sharedAt: 3, sharedBy: { name: "Alex Rivera" } },
      { id: "notes", title: "Field notes", path: "Alex/Field notes", scope: "note", level: "view", sharedAt: 2, sharedBy: { name: "Alex Rivera" } },
    ];
const controls = { opened: [] as string[], previews: [] as Array<[string, string]> };
Object.assign(window, { notionSharing: controls });

const client = {
  scope: () => "fixture-2d",
  getNote: async () => note,
  listNoteVersions: async () => ({ versions, total: versions.length }),
  getNoteVersion: async (_id: string, ix: number) => versions.find((v) => v.versionIx === ix)!,
  getPageActivity: async () => activity,
  listSharedWithMe: async () => ({ items: shared, tags: params.has("empty") ? [] : [{ tag: "field-guide", level: "view", sharedAt: 1 }] }),
  getAccessPreview: async (id: string, parent: string) => {
    controls.previews.push([id, parent]);
    return {
      willChange: true,
      losing: 2,
      gaining: 0,
      changes: [
        { email: "morgan.lee@prism.test", name: "Morgan Lee", avatar: null, from: "edit", to: null },
        { email: "sam.chen@example.test", name: "Sam Chen", avatar: null, from: "suggest", to: null },
      ],
    };
  },
} as unknown as VaultClient;
const sharing = { createShareLink: async () => "", getViewer: async () => ({ email: "jordan@prism.test", role: "member", isServerOwner: false, vaultId: "primary" }) } as unknown as CollabSharing;

function Panel() {
  const [active, setActive] = useState<string | null>(null);
  const panel = params.get("panel") ?? "history";
  if (panel === "info")
    return (
      <div style={{ width: 300, border: "1px solid var(--glass-border)", borderRadius: 12, background: "var(--bg-surface)" }}>
        <div style={{ padding: "8px 12px", fontSize: 13 }}>Page options</div>
        <PageInfo note={note} />
      </div>
    );
  if (panel === "shared")
    return (
      <aside style={{ width: "min(280px, 100%)", padding: 8, background: "var(--bg-sidebar, var(--bg-surface))", borderRight: "1px solid var(--glass-border)", minHeight: "100dvh", boxSizing: "border-box" }}>
        <SharedWithMe
          guest={params.has("guest")}
          activeId={active}
          onOpen={(item) => {
            controls.opened.push(item.id);
            setActive(item.id);
          }}
        />
      </aside>
    );
  if (panel === "move")
    return (
      <div style={{ maxWidth: 420, display: "grid", gap: 10 }}>
        <strong>Move “Research handbook” to Archive</strong>
        <MoveAccessNotice noteId="handbook" parentPath="Archive" />
      </div>
    );
  return (
    <div style={{ width: "min(420px, 100%)", margin: "0 auto" }}>
      <HistoryPanel note={note} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlatformProvider value="web">
        <CollabSharingProvider value={sharing}>
          <VaultClientProvider client={client}>
            <main style={{ padding: params.get("panel") === "shared" ? 0 : 24, background: "var(--bg-base)", minHeight: "100dvh", color: "var(--text-primary)", boxSizing: "border-box" }}>
              <Panel />
            </main>
          </VaultClientProvider>
        </CollabSharingProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
