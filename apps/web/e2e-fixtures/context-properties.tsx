import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, PropertyConflictError, type VaultClient, type Note } from "@prism/core";
import { ContextPanel } from "../../../packages/core/src/components/layout/ContextPanel";
import { useUIStore } from "../../../packages/core/src/app/stores/ui";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import { applyTheme, useSettingsStore } from "../../../packages/core/src/app/stores/settings";
const params = new URLSearchParams(location.search);
applyTheme(params.has("dark") ? "dark" : "light");
useSettingsStore.setState({ theme: params.has("dark") ? "dark" : "light" });
const controls = {
  scope: "fixture-a",
  fail: false,
  hold: false,
  pending: [] as Array<() => void>,
  writes: [] as Array<{ kind: string; value: unknown; scope?: string }>,
  query: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
};
useAgentChatStore.setState({ scope: controls.scope });
useUIStore.getState().openTab("fictional-page", "Research brief", "document");
useUIStore.setState({ contextPanelTab: "metadata" });
let note: Note = {
  id: "fictional-page",
  path: "Workspace/Research brief",
  content: "An unchanged fictional document body.",
  metadata: {
    type: "document",
    owner: "Alex Chen",
    priority: "Normal",
    approved: false,
    topics: ["Research"],
  },
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
async function write(kind: string, value: unknown, scope?: string) {
  controls.writes.push({ kind, value, scope });
  if (controls.hold) await new Promise<void>((resolve) => controls.pending.push(resolve));
  if (controls.fail) throw Error("private diagnostics");
}
const client = {
  scope: () => controls.scope,
  getNote: async () => ({ ...note }),
  listNotes: async () => [note],
  getTags: async () => [
    { tag: "project", count: 1 },
    { tag: "research", count: 2 },
  ],
  updateNote: async (_id: string, patch: Partial<Note>, opts?: { expectedScope?: string }) => {
    await write("property", patch, opts?.expectedScope);
    note = { ...note, ...patch };
    return note;
  },
  addTags: async (_id: string, tags: string[]) => {
    await write("add", tags);
    note = { ...note, tags: [...(note.tags ?? []), ...tags] };
    return note;
  },
  removeTags: async (_id: string, tags: string[]) => {
    await write("remove", tags);
    note = { ...note, tags: (note.tags ?? []).filter((tag) => !tags.includes(tag)) };
    return note;
  },
} as unknown as VaultClient;
// ?extra: a free property holding a web address (a URL property) and one holding OBJECTS (a structured value).
if (params.has("extra")) {
  note = { ...note, metadata: { ...note.metadata, website: "https://example.test/brief", reviewers: [{ name: "Ada Park", role: "lead", notes: { since: 2024 } }, { name: "Sam Rivera", role: "reader" }] } };
  (client as VaultClient).updateStructuredProperty = async (id, key, value, expect) => {
    await write("structured", { key, value, expect });
    if (JSON.stringify(note.metadata?.[key] ?? null) !== JSON.stringify(expect ?? null)) throw new PropertyConflictError([key], { [key]: note.metadata?.[key] ?? null });
    note = { ...note, metadata: { ...note.metadata, [key]: value }, updatedAt: "2026-10-02T12:00:00Z" };
    return { id, updatedAt: note.updatedAt, metadata: { ...note.metadata } };
  };
}
Object.assign(window, { contextProperties: controls, contextNote: () => note });
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
          width: "min(100%, 420px)",
          margin: "0 auto",
          height: "calc(100dvh - 54px)",
          boxSizing: "border-box",
        }}
      >
        <ContextPanel />
      </main>
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
