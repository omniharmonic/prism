import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  VaultClientProvider,
  CollabDocumentProvider,
  PlatformProvider,
  useAgentChatStore,
  useUIStore,
  type VaultClient,
  type Note,
} from "@prism/core";
import { Canvas } from "../../../packages/core/src/components/layout/Canvas";
import TaskBoardRenderer from "../../../packages/core/src/components/renderers/TaskBoardRenderer";
import { getRenderer } from "../../../packages/core/src/components/renderers/Registry";
import { DEFAULT_BOARD } from "../../../packages/core/src/lib/boards/config";
const make = (id: string, title: string, status?: string): Note => ({
  id,
  path: "Projects/Prism/" + title,
  content: "Synthetic task only",
  metadata: {
    type: id === "board" ? "task-board" : "task",
    title,
    status,
    priority: "high",
    project: "Prism",
    other: "preserve",
    prism_visibility: "private",
  },
  tags: ["task"],
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
});
let notes: Note[] = JSON.parse(
  localStorage.getItem("board-fixture") || "null",
) ?? [
  make("board", "Prism launch"),
  make("design", "Polish the editor", "todo"),
  make("custom", "Review with collaborators", "review"),
  make("blank", "Write launch notes"),
];
if (new URLSearchParams(location.search).has("future"))
  notes[0].metadata = { ...notes[0].metadata, prism_board: { version: 99 } };
if (new URLSearchParams(location.search).has("caps")) {
  notes[0]._caps = ["view"];
  notes[1]._caps = ["view"];
  notes[2]._caps = ["view", "edit"];
  notes[3]._caps = ["view"];
}
if (new URLSearchParams(location.search).has("alternate")) {
  notes[0].metadata = {
    ...notes[0].metadata,
    prism_board: {
      ...DEFAULT_BOARD,
      groupBy: "priority",
      columns: [
        { id: "high", label: "High priority" },
        { id: "low", label: "Low priority" },
      ],
    },
  };
}
if (new URLSearchParams(location.search).has("due")) {
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  notes[1].metadata = { ...notes[1].metadata, due: day(-2) };
  notes[2].metadata = { ...notes[2].metadata, due: day(0), status: "todo" };
  notes[0].metadata = { ...notes[0].metadata, prism_board: { ...DEFAULT_BOARD, columns: [...DEFAULT_BOARD.columns, { id: "review", label: "In review" }], order: ["design", "custom"] } };
}
if (new URLSearchParams(location.search).has("due-range")) {
  // A date RANGE in `due` (written by a database view): started two days ago, ends in three.
  const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  notes[1].metadata = { ...notes[1].metadata, due: `${day(-2)}/${day(3)}`, status: "todo" };
  notes[2].metadata = { ...notes[2].metadata, due: `${day(-9)}/${day(-7)}`, status: "todo" };
}
if (new URLSearchParams(location.search).has("manual-drag")) {
  notes[0].metadata = {
    ...notes[0].metadata,
    prism_board: {
      ...DEFAULT_BOARD,
      order: ["hidden-rank", "blank", "custom", "design"],
    },
  };
  notes[1].metadata = { ...notes[1].metadata, status: "todo" };
  notes[2].metadata = { ...notes[2].metadata, status: "todo" };
  notes[3].metadata = { ...notes[3].metadata, status: "done" };
  if (new URLSearchParams(location.search).has("task-readonly"))
    notes[1]._caps = ["view"];
}
let revision = 0,
  scope = "board-owner";
useAgentChatStore.setState({ scope });
const controls = {
  writes: [] as unknown[],
  creates: [] as unknown[],
  failNext: false,
  queueNext: false,
  pending: false,
  hold: false,
  readRelease: null as (() => void) | null,
  notes: () => notes,
  open: () => useUIStore.getState().openTabs,
  taskIsDocument: getRenderer("task") === getRenderer("document"),
  refresh: () => queries.invalidateQueries({ queryKey: ["vault"] }),
  switchScope: () => {
    scope = "board-guest";
    useAgentChatStore.setState({ scope });
  },
  setBoard: (groupBy: string) => {
    notes[0].metadata = {
      ...notes[0].metadata,
      prism_board: { ...DEFAULT_BOARD, groupBy },
    };
  },
  conflict: () => {
    notes[1] = {
      ...notes[1],
      updatedAt: "newer",
      metadata: { ...notes[1].metadata, other: "concurrent-change" },
    };
  },
};
Object.assign(window, { prismBoardFixture: controls });
const clone = <T,>(v: T): T => structuredClone(v);
const client = {
  scope: () => scope,
  hasPendingWrites: async () => controls.pending,
  listNotes: async (filters?: { path?: string }) => {
    const result = clone(
      scope === "board-owner"
        ? notes.filter(
            (n) =>
              n.id !== "board" && (!filters?.path || n.path === filters.path),
          )
        : [],
    );
    if (controls.hold)
      await new Promise<void>((r) => {
        controls.readRelease = r;
      });
    return result;
  },
  getNote: async (id: string) => clone(notes.find((n) => n.id === id)!),
  updateNote: async (
    id: string,
    patch: { metadata?: Record<string, unknown>; ifUpdatedAt?: string },
  ) => {
    controls.writes.push({ id, ...patch });
    if (controls.queueNext) {
      controls.queueNext = false;
      controls.pending = true;
      return clone(notes.find((n) => n.id === id)!);
    }
    if (controls.failNext) {
      controls.failNext = false;
      throw new Error("Connection interrupted. Your task has not moved.");
    }
    const i = notes.findIndex((n) => n.id === id);
    if (patch.ifUpdatedAt !== notes[i].updatedAt)
      throw new Error(
        "This task changed in another window. Refresh before moving it.",
      );
    notes[i] = {
      ...notes[i],
      metadata: { ...notes[i].metadata, ...patch.metadata },
      updatedAt: "revision-" + ++revision,
    };
    localStorage.setItem("board-fixture", JSON.stringify(notes));
    return clone(notes[i]);
  },
  createNote: async (p: Partial<Note>) => {
    controls.creates.push(p);
    if (controls.failNext) {
      controls.failNext = false;
      throw new Error("Unable to create. Your draft is still here.");
    }
    const n = { ...make("new-" + ++revision, "New task"), ...p } as Note;
    notes.push(n);
    localStorage.setItem("board-fixture", JSON.stringify(notes));
    return clone(n);
  },
} as unknown as VaultClient;
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const workspace = new URLSearchParams(location.search).has("workspace");
if (workspace)
  useUIStore.getState().openTab("board", "Prism launch", "task-board");
const seam = {
  useLiveCollab: (id: string) => !!id,
  CollabDocument: ({ noteId }: { noteId: string; note: Note }) => (
    <p data-testid="live-task">Live task document: {noteId}</p>
  ),
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queries}>
      <PlatformProvider value="web">
        <VaultClientProvider client={client}>
          <CollabDocumentProvider value={seam}>
            <main style={{ height: "100dvh" }}>
              {workspace ? (
                <Canvas />
              ) : (
                <TaskBoardRenderer
                  note={clone(notes[0])}
                  readOnly={new URLSearchParams(location.search).has(
                    "readonly",
                  )}
                />
              )}
            </main>
          </CollabDocumentProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
