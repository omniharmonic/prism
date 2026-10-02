import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, type VaultClient, type Note } from "@prism/core";
import {
  HistoryConflictError,
  VaultRequestError,
  type NoteVersion,
} from "../../../packages/core/src/data/VaultClient";
import { ContextPanel } from "../../../packages/core/src/components/layout/ContextPanel";
import { useAutoSave } from "../../../packages/core/src/app/hooks/useAutoSave";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import { useUIStore } from "../../../packages/core/src/app/stores/ui";
import { applyTheme, useSettingsStore } from "../../../packages/core/src/app/stores/settings";
const params = new URLSearchParams(location.search);
applyTheme(params.has("dark") ? "dark" : "light");
useSettingsStore.setState({ theme: params.has("dark") ? "dark" : "light" });
const controls = {
  scope: "fixture-a",
  failList: false,
  failVersion: false,
  deny: false,
  denyEdit: false,
  conflict: false,
  hold: false,
  holdRestore: false,
  pending: [] as Array<() => void>,
  writes: [] as Array<{ kind: string; timestamp?: string; content?: string }>,
  reads: [] as Array<{ id: string; fresh: boolean; scope: string }>,
  offsets: [] as number[],
  ui: useUIStore,
  query: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  schedule: () => {},
};
useAgentChatStore.setState({ scope: controls.scope });
useUIStore.getState().openTab("fictional-page", "Research brief", "document");
useUIStore.setState({ contextPanelTab: "history" });
let note: Note = {
  id: "fictional-page",
  path: "Workspace/Research brief",
  content: "Current research brief.\nA collaborative plan for the new workspace.",
  metadata: { type: "document" },
  tags: ["project"],
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  ...(params.has("readonly")
    ? { _caps: ["read"] }
    : params.has("propose")
      ? { _caps: ["read", "suggest"] }
      : params.has("edit")
        ? { _caps: ["read", "edit"] }
        : {}),
};
const version = (ix: number): NoteVersion => ({
  versionIx: ix,
  op: ix === 2 ? "restore" : "update",
  supersededAt: new Date(Date.UTC(2026, 8, 30 - ix, 12)).toISOString(),
  path: "Workspace/Research brief",
  metadata: { type: "document" },
  contentLength: 55,
  actor: params.has("readonly") || params.has("propose") ? undefined : "Alex Chen",
  via: params.has("readonly") || params.has("propose") ? undefined : "Prism",
  content:
    controls.scope === "fixture-b"
      ? "New audience version body"
      : `Earlier research brief ${ix}.\nA focused plan for the workspace.`,
});
const client = {
  scope: () => controls.scope,
  getNote: async (id: string, opts?: { fresh?: boolean }) => {
    controls.reads.push({ id, fresh: !!opts?.fresh, scope: controls.scope });
    if (controls.hold) await new Promise<void>((resolve) => controls.pending.push(resolve));
    if (controls.deny) throw new VaultRequestError(403, "private diagnostics");
    return { ...note, ...(controls.denyEdit ? { _caps: ["read"] } : {}) };
  },
  listNoteVersions: async (_id: string, { offset = 0, limit = 50 } = {}) => {
    controls.offsets.push(offset);
    if (controls.failList) throw Error("private diagnostics");
    const total = params.has("empty") ? 0 : params.has("paged") ? 52 : 3;
    return {
      versions: Array.from({ length: Math.min(limit, total - offset) }, (_, i) => version(i + offset + 1)),
      total,
    };
  },
  getNoteVersion: async (_id: string, ix: number) => {
    if (controls.failVersion) throw Error("private diagnostics");
    return version(ix);
  },
  restoreNoteVersion: async (_id: string, ix: number, ifUpdatedAt: string) => {
    controls.writes.push({ kind: "restore", timestamp: ifUpdatedAt });
    if (controls.holdRestore) await new Promise<void>((resolve) => controls.pending.push(resolve));
    if (controls.conflict) throw new HistoryConflictError();
    note = { ...note, content: version(ix).content!, updatedAt: "2026-10-02T12:00:00Z" };
    return note;
  },
  updateNote: async (_id: string, patch: Partial<Note>) => {
    controls.writes.push({ kind: "flush", content: patch.content });
    note = { ...note, ...patch, updatedAt: "2026-10-02T11:00:00Z" };
    return note;
  },
} as unknown as VaultClient;
if (params.has("unsupported")) delete (client as Partial<VaultClient>).listNoteVersions;
Object.assign(window, { contextHistory: controls });
const draftContent = () => "Unsent fictional draft";
function AutoSaveHarness() {
  const { scheduleSave } = useAutoSave("fictional-page", draftContent, 60000);
  useEffect(() => {
    controls.schedule = scheduleSave;
  }, [scheduleSave]);
  return null;
}
function Fixture() {
  return (
    <>
      <nav style={{ padding: 12 }}>
        <button
          onClick={() => {
            controls.scope = "fixture-b";
            useAgentChatStore.setState({ scope: controls.scope });
          }}
        >
          Switch workspace
        </button>
      </nav>
      <main
        style={{
          width: "min(100%,420px)",
          height: "calc(100dvh - 54px)",
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        <ContextPanel />
      </main>
      <AutoSaveHarness />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={controls.query}>
      <PlatformProvider value="web">
        <VaultClientProvider client={client}>
          <Fixture />
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
