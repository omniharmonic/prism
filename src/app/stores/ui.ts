import { create } from "zustand";
import type { ContentType, TabState } from "../../lib/types";

export interface PendingEdit {
  noteId: string;
  content: string;
  mode: "append" | "replace";
}

interface UIStore {
  // Sidebar
  sidebarOpen: boolean;
  sidebarWidth: number;

  // Context panel
  contextPanelOpen: boolean;
  contextPanelWidth: number;
  contextPanelTab: "agent" | "metadata" | "links" | "history" | "graph";

  // Tabs
  openTabs: TabState[];
  activeTabId: string | null;

  // Command bar
  commandBarOpen: boolean;

  // Inline prompt
  inlinePromptOpen: boolean;
  inlinePromptPosition: { x: number; y: number } | null;
  inlinePromptSelection: string;

  // Pending editor edit (agent → editor communication)
  pendingEdit: PendingEdit | null;

  // Graph fullscreen
  graphFullscreen: boolean;

  // Ghost text: agent-generated content waiting for accept/reject
  ghostText: { noteId: string; content: string; position: "cursor" | "end" } | null;

  // Actions
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleContextPanel: () => void;
  setContextPanelWidth: (width: number) => void;
  setContextPanelTab: (tab: UIStore["contextPanelTab"]) => void;

  openTab: (noteId: string, title: string, type: ContentType) => void;
  closeTab: (tabId: string) => void;
  closeTabs: (noteId: string) => void;
  setActiveTab: (tabId: string) => void;
  markTabDirty: (tabId: string, isDirty: boolean) => void;

  openCommandBar: () => void;
  closeCommandBar: () => void;

  openInlinePrompt: (position: { x: number; y: number }, selection: string) => void;
  closeInlinePrompt: () => void;

  setGraphFullscreen: (open: boolean) => void;

  setPendingEdit: (edit: PendingEdit) => void;
  clearPendingEdit: () => void;

  setGhostText: (ghost: { noteId: string; content: string; position: "cursor" | "end" }) => void;
  acceptGhostText: () => void;
  rejectGhostText: () => void;
}

export const useUIStore = create<UIStore>((set, get) => ({
  sidebarOpen: true,
  sidebarWidth: 260,
  contextPanelOpen: false,
  contextPanelWidth: 320,
  contextPanelTab: "metadata",
  openTabs: [],
  activeTabId: null,
  commandBarOpen: false,
  inlinePromptOpen: false,
  inlinePromptPosition: null,
  inlinePromptSelection: "",
  graphFullscreen: false,
  pendingEdit: null,
  ghostText: null,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(400, width)) }),

  toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
  setContextPanelWidth: (width) => set({ contextPanelWidth: Math.max(260, Math.min(480, width)) }),
  setContextPanelTab: (tab) => set({ contextPanelTab: tab }),
  setGraphFullscreen: (open) => set({ graphFullscreen: open }),

  openTab: (noteId, title, type) => {
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.noteId === noteId);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const newTab: TabState = {
      id: `tab-${noteId}`,
      noteId,
      title,
      type,
      isDirty: false,
    };
    set({
      openTabs: [...openTabs, newTab],
      activeTabId: newTab.id,
    });
  },

  closeTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    const filtered = openTabs.filter((t) => t.id !== tabId);

    let nextActive = activeTabId;
    if (activeTabId === tabId) {
      if (filtered.length === 0) {
        nextActive = null;
      } else {
        nextActive = filtered[Math.min(idx, filtered.length - 1)].id;
      }
    }

    set({ openTabs: filtered, activeTabId: nextActive });
  },

  closeTabs: (noteId) => {
    const { openTabs, activeTabId } = get();
    const filtered = openTabs.filter((t) => t.noteId !== noteId);
    let nextActive = activeTabId;
    if (activeTabId && !filtered.find((t) => t.id === activeTabId)) {
      nextActive = filtered.length > 0 ? filtered[filtered.length - 1].id : null;
    }
    set({ openTabs: filtered, activeTabId: nextActive });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  markTabDirty: (tabId, isDirty) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty } : t,
      ),
    })),

  openCommandBar: () => set({ commandBarOpen: true }),
  closeCommandBar: () => set({ commandBarOpen: false }),

  openInlinePrompt: (position, selection) => set({
    inlinePromptOpen: true,
    inlinePromptPosition: position,
    inlinePromptSelection: selection,
  }),
  closeInlinePrompt: () => set({
    inlinePromptOpen: false,
    inlinePromptPosition: null,
    inlinePromptSelection: "",
  }),

  setPendingEdit: (edit) => set({ pendingEdit: edit }),
  clearPendingEdit: () => set({ pendingEdit: null }),

  setGhostText: (ghost) => set({ ghostText: ghost }),
  acceptGhostText: () => {
    const { ghostText } = get();
    if (ghostText) {
      // Convert ghost text to a pending edit that the editor will apply
      set({
        pendingEdit: { noteId: ghostText.noteId, content: ghostText.content, mode: ghostText.position === "cursor" ? "replace" : "append" },
        ghostText: null,
      });
    }
  },
  rejectGhostText: () => set({ ghostText: null }),
}));
