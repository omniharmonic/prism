import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PlatformProvider,
  VaultClientProvider,
  useUIStore,
  type Note,
  type VaultClient,
  type CreateNoteParams,
} from "@prism/core";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import { NewContentMenu } from "../../../packages/core/src/components/navigation/NewContentMenu";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.remove("light");
const date = "2026-10-02T12:00:00Z";
const prefix = params.has("prefixed") ? "vault/" : "";
let audience = "creation-owner";
const initial: Note[] = [
  {
    id: "active",
    path: `${prefix}Projects/Prism/Working page`,
    content: "<p>Existing page</p>",
    tags: [],
    metadata: { type: "document" },
    createdAt: date,
    updatedAt: date,
  },
  {
    id: "journal",
    path: `${prefix}Journal/Weekly review`,
    content: "<p>Weekly review</p>",
    tags: [],
    metadata: {},
    createdAt: date,
    updatedAt: date,
  },
  {
    id: "duplicate",
    path: `${prefix}Projects/Prism/Untitled`,
    content: "<p>Keep me</p>",
    tags: [],
    metadata: {},
    createdAt: date,
    updatedAt: date,
  },
];
let notes: Note[] =
  JSON.parse(localStorage.getItem("page-creation-fixture-notes") || "null") ??
  initial;
const controls = {
  requests: [] as CreateNoteParams[],
  fail: false,
  failTree: params.has("tree-error"),
  hold: false,
  release: () => {},
  treeReads: 0,
  switchScope: () => {
    audience = "creation-other";
    useAgentChatStore.setState({ scope: audience });
  },
  latest: () => notes.at(-1),
};
Object.assign(window, { prismCreation: controls });
useAgentChatStore.setState({ scope: params.has("legacy") ? null : audience });
useUIStore
  .getState()
  .openTab(
    params.has("virtual")
      ? "calendar-dashboard"
      : (localStorage.getItem("page-creation-fixture-active") ?? "active"),
    "Working page",
    "document",
  );
const vault = {
  scope: params.has("legacy") ? undefined : () => audience,
  listTree: async () => {
    controls.treeReads++;
    if (controls.failTree) throw Error("Folder fixture unavailable");
    return notes.map(({ content, ...rest }) => rest);
  },
  listNotes: async () => notes,
  getNote: async (id: string) => notes.find((note) => note.id === id)!,
  getTags: async () => [],
  createNote: async (input: CreateNoteParams) => {
    controls.requests.push(input);
    if (controls.hold)
      await new Promise<void>((resolve) => {
        controls.release = resolve;
      });
    if (controls.fail) throw Error("Couldn't create this page. Try again.");
    const note: Note = {
      ...input,
      id: `created-${notes.length}`,
      path: input.path ?? null,
      metadata: input.metadata ?? null,
      tags: input.tags ?? [],
      createdAt: date,
      updatedAt: date,
    };
    notes.push(note);
    localStorage.setItem("page-creation-fixture-notes", JSON.stringify(notes));
    localStorage.setItem("page-creation-fixture-active", note.id);
    return note;
  },
  updateNote: async (id: string, changes: Partial<Note>) => {
    const note = notes.find((item) => item.id === id)!;
    Object.assign(note, changes, { updatedAt: new Date().toISOString() });
    localStorage.setItem("page-creation-fixture-notes", JSON.stringify(notes));
    return note;
  },
} as unknown as VaultClient;
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function NavigationFixture({ children }: { children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      aria-label="Navigation fixture"
      ref={dialog}
      onCancel={() => dialog.current?.close()}
    >
      {children}
    </dialog>
  );
}
function Fixture() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const tabs = useUIStore((s) => s.openTabs);
  const active = useUIStore((s) => s.activeTabId);
  const currentId = tabs.find((tab) => tab.id === active)?.noteId;
  const selected = notes.find((note) => note.id === currentId);
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        padding: 24,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 40,
        }}
      >
        <strong>Prism</strong>
        <button
          className="rounded-lg border px-4 py-2"
          ref={opener}
          onClick={() => setOpen(true)}
        >
          New page
        </button>
      </header>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Projects / Prism
      </p>
      <h1 style={{ fontSize: 34, marginBottom: 16 }}>A living workspace</h1>
      {selected?.id.startsWith("created-") ? (
        <DocumentRenderer key={selected.id} note={selected} />
      ) : (
        <p>A place for ideas, conversations, and work in progress.</p>
      )}
      {open && (
        <NewContentMenu
          returnFocus={opener.current}
          initialFolder={params.get("folder") ?? undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <QueryClientProvider client={qc}>
        <VaultClientProvider client={vault}>
          {params.has("nested") ? (
            <NavigationFixture>
              <Fixture />
            </NavigationFixture>
          ) : (
            <Fixture />
          )}
        </VaultClientProvider>
      </QueryClientProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
