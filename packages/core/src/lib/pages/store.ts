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

/** NP-SB-06: expansion persists on this device, per account + vault (`VaultClient.scope()`). */
const EXPANDED_PREFIX = "prism:tree-expanded:";
const EXPANDED_MAX = 500;
function readExpanded(scope: string): Record<string, true> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_PREFIX + scope) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return {};
    const out: Record<string, true> = {};
    for (const path of raw.slice(0, EXPANDED_MAX)) if (typeof path === "string") out[path] = true;
    return out;
  } catch { return {}; }
}
function writeExpanded(scope: string | null, expanded: Record<string, true>): void {
  if (scope === null) return;
  try {
    const paths = Object.keys(expanded).slice(-EXPANDED_MAX);
    if (paths.length) localStorage.setItem(EXPANDED_PREFIX + scope, JSON.stringify(paths));
    else localStorage.removeItem(EXPANDED_PREFIX + scope);
  } catch { /* no storage: in-memory only */ }
}

interface PagesUIState {
  /** Expanded tree rows, keyed by the row's full (raw) path. */
  expanded: Record<string, true>;
  /** Which account + vault `expanded` belongs to (null = not persisted yet). */
  expandedScope: string | null;
  /** Load this scope's remembered expansion (called by the tree when the vault is known or changes). */
  setExpandedScope: (scope: string) => void;
  toggleExpanded: (path: string, open?: boolean) => void;
  /** Expand every ancestor of `path` (breadcrumb "show in sidebar"). */
  reveal: (path: string) => void;
  collapseAll: () => void;
  /** Sign-out / account change: forget the in-memory expansion too (storage is cleared by the host). */
  resetExpanded: () => void;

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
  expandedScope: null,
  setExpandedScope: (scope) => {
    if (get().expandedScope === scope) return;
    // Rows opened before the scope was known (the reveal of the first page) are kept.
    const carried = get().expandedScope === null ? get().expanded : {};
    set({ expandedScope: scope, expanded: { ...readExpanded(scope), ...carried } });
  },
  toggleExpanded: (path, open) =>
    set((s) => {
      const next = { ...s.expanded };
      const want = open ?? !next[path];
      if (want) next[path] = true;
      else delete next[path];
      writeExpanded(s.expandedScope, next);
      return { expanded: next };
    }),
  reveal: (path) =>
    set((s) => {
      const next = { ...s.expanded };
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) next[parts.slice(0, i).join("/")] = true;
      writeExpanded(s.expandedScope, next);
      return { expanded: next };
    }),
  collapseAll: () => { writeExpanded(get().expandedScope, {}); set({ expanded: {} }); },
  resetExpanded: () => set({ expanded: {}, expandedScope: null }),

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

// The host announces sign-out / account change (`prism:signed-out`): the previous
// account's open folders must not stay in memory for the next one.
if (typeof window !== "undefined") window.addEventListener("prism:signed-out", () => usePagesUI.getState().resetExpanded());
