import { create } from "zustand";
import type { ContentType, TabState } from "../../lib/types";

interface UIStore {
  // Sidebar
  sidebarOpen: boolean;
  sidebarWidth: number;

  // Context panel
  contextPanelOpen: boolean;
  contextPanelWidth: number;
  contextPanelTab: "agent" | "metadata" | "links" | "history";

  // Tabs
  openTabs: TabState[];
  activeTabId: string | null;

  // Command bar
  commandBarOpen: boolean;

  // Actions
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleContextPanel: () => void;
  setContextPanelWidth: (width: number) => void;
  setContextPanelTab: (tab: UIStore["contextPanelTab"]) => void;

  openTab: (noteId: string, title: string, type: ContentType) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  markTabDirty: (tabId: string, isDirty: boolean) => void;

  openCommandBar: () => void;
  closeCommandBar: () => void;
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

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(400, width)) }),

  toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
  setContextPanelWidth: (width) => set({ contextPanelWidth: Math.max(260, Math.min(480, width)) }),
  setContextPanelTab: (tab) => set({ contextPanelTab: tab }),

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

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  markTabDirty: (tabId, isDirty) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty } : t,
      ),
    })),

  openCommandBar: () => set({ commandBarOpen: true }),
  closeCommandBar: () => set({ commandBarOpen: false }),
}));
