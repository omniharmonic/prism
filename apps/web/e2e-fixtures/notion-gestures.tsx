/**
 * Phone gestures on the Messages list (NP-MB-06): pull-to-refresh and email row swipes.
 * The real VaultMessagesDashboard over a mock vault client and a fake live-actions client.
 * Fictional data; never connects to a server. `?noactions` = the shell has no live email
 * actions (rows then have no swipe).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveActionsProvider, PlatformProvider, VaultClientProvider, type Note, type VaultClient } from "@prism/core";
import VaultMessagesDashboard from "../../../packages/core/src/components/comms/VaultMessagesDashboard";
import { usePagesUI } from "../../../packages/core/src/lib/pages/store";
import type { LiveActionsClient } from "../../../packages/core/src/lib/actions/client";

const params = new URLSearchParams(location.search);
const date = "2026-10-01T12:00:00.000Z";
const at = Date.UTC(2026, 9, 1, 12);
const email = (i: number, unread: boolean): Note => ({
  id: `mail-${i}`, path: `vault/messages/email/Budget question ${i}`, tags: ["email"],
  content: `# Budget question ${i}\n\nCan we review line ${i}?`,
  metadata: { type: "email", subject: `Budget question ${i}`, from: "Morgan <morgan@example.test>", isUnread: unread, lastMessageAt: at - i * 60_000, messageId: `m${i}@example.test`, source: "proton-bridge" },
  createdAt: date, updatedAt: date,
});
const thread: Note = {
  id: "room-1", path: "vault/messages/chat/Team room", tags: ["message-thread"],
  content: "# Team room\n\n[2026-10-01 10:15] Alex: Shall we meet on Friday?",
  metadata: { type: "message-thread", platform: "telegram", lastMessageAt: at, participants: ["Alex"], messageCount: 1 },
  createdAt: date, updatedAt: date,
};
const emails = Array.from({ length: 14 }, (_, i) => email(i + 1, i < 2));
const state = { reads: { threads: 0, emails: 0, people: 0, graph: 0 }, actions: [] as Array<{ action: string; noteId: string; read?: boolean }>, failRefresh: false };
const client = {
  scope: () => "fixture",
  listNotes: async (q: { tag?: string }) => {
    if (q.tag === "message-thread") { state.reads.threads++; if (state.failRefresh) throw new Error("fixture offline"); return [thread]; }
    if (q.tag === "email") { state.reads.emails++; return emails.map((n) => structuredClone(n)); }
    state.reads.people++;
    return [];
  },
  getGraph: async () => { state.reads.graph++; return { nodes: [], edges: [] }; },
  getNote: async (id: string) => structuredClone([thread, ...emails].find((n) => n.id === id)!),
  getLinks: async () => [],
  getTags: async () => [],
} as unknown as VaultClient;
const actions = {
  scope: () => "fixture",
  status: async () => ({ email: { enabled: true, configured: true }, matrix: { enabled: false, configured: false, agentRooms: 0 }, calendar: { enabled: false, configured: false } }),
  emailArchive: async (t: { noteId: string }) => { state.actions.push({ action: "archive", noteId: t.noteId }); const i = emails.findIndex((n) => n.id === t.noteId); if (i >= 0) emails.splice(i, 1); return { archived: true }; },
  emailMarkRead: async (t: { noteId: string }, read: boolean) => { state.actions.push({ action: "mark-read", noteId: t.noteId, read }); const n = emails.find((x) => x.id === t.noteId); if (n) n.metadata = { ...n.metadata, isUnread: !read }; return { read }; },
} as unknown as LiveActionsClient;
Object.assign(window, { prismGestures: state, prismGesturesToast: () => usePagesUI.getState().toast?.message ?? null });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <VaultClientProvider client={client}>
          <LiveActionsProvider client={params.has("noactions") ? null : actions}>
            <main style={{ background: "var(--bg-base)", color: "var(--text-primary)", height: "100dvh", display: "flex", flexDirection: "column" }}>
              <VaultMessagesDashboard note={{ id: "messages-dashboard", path: null, content: "", tags: [], metadata: {} } as unknown as Note} />
            </main>
          </LiveActionsProvider>
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
