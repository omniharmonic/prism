/**
 * UI state for pages: which tree rows are expanded, which page dialog is open,
 * and the one transient toast (with an optional action such as Undo). Separate
 * from the shared UI store so page features stay self-contained.
 */
import { create } from "zustand";

export interface PageRef {
  id: string;
  path: string | null;
  title: string;
}

export interface PageToast {
  id: number;
  message: string;
  tone?: "info" | "error";
  action?: { label: string; run: () => void };
}

interface PagesUIState {
  /** Expanded tree rows, keyed by the row's full (raw) path. */
  expanded: Record<string, true>;
  toggleExpanded: (path: string, open?: boolean) => void;
  /** Expand every ancestor of `path` (breadcrumb "show in sidebar"). */
  reveal: (path: string) => void;
  collapseAll: () => void;

  movePage: PageRef | null;
  openMove: (page: PageRef | null) => void;
  trashOpen: boolean;
  openTrash: (open: boolean) => void;
  /** "Add a page inside" / "New page from template": the creation dialog's start state. */
  /** `{}`/`{folder}` = create "Untitled" at once (NP-SB-13); `template`/`chooser` open the dialog. */
  create: { folder?: string; template?: boolean; chooser?: boolean } | null;
  openCreate: (create: { folder?: string; template?: boolean; chooser?: boolean } | null) => void;
  /** Phone: the page-actions sheet for this page. */
  actionsFor: PageRef | null;
  openActions: (page: PageRef | null) => void;

  toast: PageToast | null;
  showToast: (t: Omit<PageToast, "id">) => void;
  dismissToast: (id?: number) => void;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const usePagesUI = create<PagesUIState>((set, get) => ({
  expanded: {},
  toggleExpanded: (path, open) =>
    set((s) => {
      const next = { ...s.expanded };
      const want = open ?? !next[path];
      if (want) next[path] = true;
      else delete next[path];
      return { expanded: next };
    }),
  reveal: (path) =>
    set((s) => {
      const next = { ...s.expanded };
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) next[parts.slice(0, i).join("/")] = true;
      return { expanded: next };
    }),
  collapseAll: () => set({ expanded: {} }),

  movePage: null,
  openMove: (page) => set({ movePage: page }),
  trashOpen: false,
  openTrash: (open) => set({ trashOpen: open }),
  create: null,
  openCreate: (create) => set({ create }),
  actionsFor: null,
  openActions: (page) => set({ actionsFor: page }),

  toast: null,
  showToast: (t) => {
    const id = ++toastSeq;
    clearTimeout(toastTimer);
    set({ toast: { ...t, id } });
    toastTimer = setTimeout(() => get().dismissToast(id), t.action ? 8000 : 5000);
  },
  dismissToast: (id) => {
    if (id === undefined || get().toast?.id === id) set({ toast: null });
  },
}));
