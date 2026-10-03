import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  FileText,
  Code,
  Mail,
  MessageSquare,
  CheckSquare,
  Calendar,
  Table2,
  Globe,
  FolderOpen,
  Folder,
  MonitorPlay,
  StickyNote,
  LayoutDashboard,
  FolderPlus,
  Pencil,
  FolderInput,
  Trash2,
  FilePlus,
  GitFork,
  Radio,
  MapPin,
  ChevronRight,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useVaultTree, useUpdateNote, useCreateNote } from "../../app/hooks/useParachute";
import { GitHubSyncModal } from "../layout/GitHubSyncModal";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { inferContentType } from "../../lib/schemas/content-types";
import type { ContentType, NoteTreeEntry } from "../../lib/types";
import { NewContentMenu } from "./NewContentMenu";
import { Spinner } from "../ui/Spinner";
import { useQueryClient } from "@tanstack/react-query";
import { comparePages, isUnder, orderOf, parentOf, planReorder, protectionReason, withoutTrashed } from "../../lib/pages/model";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { usePageActions } from "../../lib/pages/usePageActions";
import { PageMenuPopover, usePageMenuItems } from "../pages/PageActionsMenu";
import { renamePath } from "../renderers/DocumentChrome";
import "../pages/pages.css";

// Icon mapping for content types
const TYPE_ICONS: Record<ContentType, React.ElementType> = {
  document: FileText,
  note: StickyNote,
  presentation: MonitorPlay,
  code: Code,
  email: Mail,
  "message-thread": MessageSquare,
  "task-board": CheckSquare,
  task: CheckSquare,
  event: Calendar,
  project: FolderOpen,
  spreadsheet: Table2,
  website: Globe,
  canvas: FileText,
  briefing: FileText,
  dashboard: LayoutDashboard,
  "messages-dashboard": MessageSquare,
  network: Radio,
  "bioregion-entity": MapPin,
  database: Table2,
};

/**
 * One sidebar row. NESTED PAGES (lib/pages/model.ts): a page note at `X` and the
 * notes at `X/…` share ONE node — the page is the parent, so it opens on click and
 * discloses its sub-pages with the chevron. A path prefix with no page note stays
 * a plain folder node, so every existing vault renders exactly as before.
 */
interface TreeNode {
  name: string;
  fullPath: string;
  /** The raw vault path (before normalization) — used for operations */
  rawPath: string;
  children: TreeNode[];
  note?: NoteTreeEntry;
}

// Paths to hide from the project tree (templates, staging pipeline)
const HIDDEN_PREFIXES = ["_templates", "_staging"];

// Normalize a vault path: strip "vault/" prefix, clean up display
function normalizePath(path: string): string {
  return path.startsWith("vault/") ? path.slice(6) : path;
}

export function buildTree(notes: NoteTreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", fullPath: "", rawPath: "", children: [] };
  for (const note of withoutTrashed(notes)) {
    const rawPath = note.path || "Unsorted";
    const normalized = normalizePath(rawPath);
    if (HIDDEN_PREFIXES.some((p) => normalized.startsWith(p))) continue;
    const parts = normalized.split("/").filter(Boolean);
    if (!parts.length) continue;
    // The personal vault's paths carry a literal "vault/" prefix (desktop
    // convention); other vaults (e.g. the commons) don't. A folder's OPERATIONAL
    // path must mirror its notes' real paths.
    const rawPrefix = rawPath.startsWith("vault/") ? "vault/" : "";
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const fp = parts.slice(0, i + 1).join("/");
      let child = current.children.find((c) => c.name === parts[i] && !(leaf && c.note));
      if (!child) {
        child = { name: parts[i]!, fullPath: fp, rawPath: leaf ? rawPath : rawPrefix + fp, children: [] };
        current.children.push(child);
      }
      if (leaf) {
        child.note = note;
        child.rawPath = rawPath;
      }
      current = child;
    }
  }
  const order = (n: TreeNode) => (n.note ? orderOf(n.note) : null);
  function sortTree(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      // Plain folders first (unchanged), then pages: manual order, then name.
      if (!a.note !== !b.note) return a.note ? 1 : -1;
      if (!a.note) return a.name.localeCompare(b.name);
      return comparePages({ name: a.name, order: order(a) }, { name: b.name, order: order(b) });
    });
    nodes.forEach((n) => sortTree(n.children));
  }
  sortTree(root.children);
  return root.children;
}

/** All notes under a node, the node's own page included. */
function collectNotes(node: TreeNode): NoteTreeEntry[] {
  const notes: NoteTreeEntry[] = node.note ? [node.note] : [];
  for (const child of node.children) notes.push(...collectNotes(child));
  return notes;
}
/** The pages a folder delete must trash: each top-most page (its sub-pages go with it). */
function topPages(node: TreeNode): NoteTreeEntry[] {
  return node.children.flatMap((c) => (c.note ? [c.note] : topPages(c)));
}
/** A flat ordered list of note IDs from the tree (for shift-click range selection) */
function getFlatNoteIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [...(n.note ? [n.note.id] : []), ...getFlatNoteIds(n.children)]);
}
function findNode(nodes: TreeNode[], pred: (n: TreeNode) => boolean): TreeNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    const hit = findNode(n.children, pred);
    if (hit) return hit;
  }
  return null;
}
const pageRef = (node: TreeNode): PageRef => ({ id: node.note!.id, path: node.note!.path, title: node.name });
const rawKey = (n: TreeNode) => `${n.rawPath}\u0000${n.note?.id ?? ""}`;

// ─── Folder context menu (plain folders only; pages use the page menu) ─────

interface FolderMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

function FolderMenu({
  state,
  onClose,
  onNewFolder,
  onNewNote,
  onRename,
  onMove,
  onDelete,
  onSyncToGitFork,
}: {
  state: FolderMenuState;
  onClose: () => void;
  onNewFolder: (node: TreeNode) => void;
  onNewNote: (node: TreeNode) => void;
  onRename: (node: TreeNode) => void;
  onMove: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  onSyncToGitFork: (node: TreeNode) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const guarded = !!protectionReason({ path: state.node.rawPath });
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);
  const items = [
    { icon: FolderPlus, label: "New folder", action: () => onNewFolder(state.node) },
    { icon: FilePlus, label: "New note", action: () => onNewNote(state.node) },
    ...(guarded
      ? []
      : [
          { icon: Pencil, label: "Rename", action: () => onRename(state.node) },
          { icon: FolderInput, label: "Move to...", action: () => onMove(state.node) },
          { icon: Trash2, label: "Move to Trash", action: () => onDelete(state.node), danger: true },
        ]),
    { icon: GitFork, label: "Sync to GitHub...", action: () => onSyncToGitFork(state.node) },
  ];
  return (
    <div ref={menuRef} className="fixed z-50 py-1 glass-elevated" style={{ left: state.x, top: state.y, borderRadius: "var(--radius-md)", minWidth: 160 }}>
      {items.map(({ icon: Icon, label, action, danger }) => (
        <button
          key={label}
          onClick={() => {
            action();
            onClose();
          }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors"
          style={{ color: danger ? "var(--color-danger)" : "var(--text-primary)" }}
        >
          <Icon size={13} style={{ color: danger ? "var(--color-danger)" : "var(--text-secondary)" }} />
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Inline Edit Input ───────────────────────────────────────

function InlineEdit({ initialValue, onConfirm, onCancel, label }: { initialValue: string; onConfirm: (value: string) => void; onCancel: () => void; label: string }) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const doConfirm = () => {
    if (confirmedRef.current) return; // prevent double-fire (Enter + unmount blur)
    confirmedRef.current = true;
    if (value.trim() && value.trim() !== initialValue) onConfirm(value.trim());
    else onCancel();
  };
  return (
    <input
      ref={inputRef}
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") doConfirm();
        if (e.key === "Escape") {
          confirmedRef.current = true;
          onCancel();
        }
      }}
      onBlur={doConfirm}
      autoFocus
      className="w-full h-6 px-1.5 text-sm rounded outline-none"
      style={{ background: "var(--glass)", border: "1px solid var(--color-accent)", color: "var(--text-primary)", fontSize: 16 }}
    />
  );
}

// ─── Folder move dialog (plain folders: a prefix rename of every note inside) ─

function FolderMoveDialog({ node, allPaths, onMove, onClose }: { node: TreeNode; allPaths: string[]; onMove: (destPath: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = allPaths
    .filter((p) => p.toLowerCase().includes(query.toLowerCase()) && p !== node.rawPath && !isUnder(p, node.rawPath) && !protectionReason({ path: p }))
    .slice(0, 10);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="glass-elevated w-full max-w-sm mx-4 p-4" style={{ borderRadius: "var(--radius-lg)" }} onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium mb-3" style={{ color: "var(--text-primary)" }}>
          Move "{node.name}" to...
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search folders..."
          aria-label="Search folders"
          autoFocus
          className="w-full h-8 rounded-md px-2.5 text-sm outline-none mb-2"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
        <div className="max-h-48 overflow-auto space-y-0.5">
          <button onClick={() => onMove("")} className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors" style={{ color: "var(--text-secondary)" }}>
            / (vault root)
          </button>
          {filtered.map((p) => (
            <button key={p} onClick={() => onMove(p)} className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors truncate" style={{ color: "var(--text-secondary)" }}>
              {normalizePath(p)}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, body, confirm, onConfirm, onCancel }: { title: string; body: string; confirm: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div role="alertdialog" aria-label={title} className="glass-elevated w-full max-w-xs mx-4 p-4" style={{ borderRadius: "var(--radius-lg)" }} onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium mb-2" style={{ color: "var(--text-primary)" }}>
          {title}
        </div>
        <div className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          {body}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-secondary)" }}>
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 rounded-md text-xs font-medium" style={{ background: "var(--color-danger)", color: "white" }}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

type DropZone = "before" | "inside" | "after";

export function ProjectTree() {
  const { data: notes, isLoading } = useVaultTree();
  const tree = useMemo(() => buildTree(notes || []), [notes]);
  const queryClient = useQueryClient();
  const updateNote = useUpdateNote();
  const createNote = useCreateNote();
  const actions = usePageActions();
  const isMobile = useIsMobile();

  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [creationFolder, setCreationFolder] = useState<string | null>(null);
  const contextTrigger = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<TreeNode | null>(null);
  const [newFolder, setNewFolder] = useState<{ parentPath: string } | null>(null);
  const [moveFolder, setMoveFolder] = useState<TreeNode | null>(null);
  const [moveProgress, setMoveProgress] = useState<{ done: number; total: number } | null>(null);
  const movingRef = useRef(false);
  const [trashFolder, setTrashFolder] = useState<TreeNode | null>(null);
  const [githubSyncPath, setGitForkSyncPath] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ node: TreeNode; over: string | null; zone: DropZone | null } | null>(null);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [batchTrashConfirm, setBatchTrashConfirm] = useState(false);

  // "Collapse all" (any caller of collapseNav) bumps this counter.
  const collapseSignal = useUIStore((s) => s.navCollapseSignal);
  const lastSignal = useRef(collapseSignal);
  useEffect(() => {
    if (lastSignal.current === collapseSignal) return;
    lastSignal.current = collapseSignal;
    usePagesUI.getState().collapseAll();
  }, [collapseSignal]);

  // Reveal the open page in the tree (Notion-style): expand its ancestors.
  const activeNoteId = useUIStore((s) => s.openTabs.find((t) => t.id === s.activeTabId)?.noteId);
  useEffect(() => {
    if (!activeNoteId || !notes) return;
    const entry = notes.find((n) => n.id === activeNoteId);
    if (entry?.path && entry.path.includes("/")) usePagesUI.getState().reveal(parentOf(entry.path));
  }, [activeNoteId, notes]);

  // Gather all unique directory paths for the folder move dialog
  const dirPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const note of notes || []) {
      const parts = (note.path || "").split("/");
      for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/"));
    }
    return Array.from(paths).sort();
  }, [notes]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["vault"] });
  }, [queryClient]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      e.preventDefault();
      e.stopPropagation();
      contextTrigger.current = e.currentTarget as HTMLElement;
      if (node.note) {
        if (isMobile) usePagesUI.getState().openActions(pageRef(node));
        else setPageMenu({ x: e.clientX, y: e.clientY, node });
      } else setFolderMenu({ x: e.clientX, y: e.clientY, node });
    },
    [isMobile],
  );

  // ─── Operations ──────────────────────────────────

  const handleNewFolderConfirm = useCallback(
    async (name: string) => {
      if (!newFolder) return;
      await createNote.mutateAsync({ content: " ", path: `${newFolder.parentPath}/${name}/.keep` });
      invalidate();
      setNewFolder(null);
    },
    [newFolder, createNote, invalidate],
  );

  const handleRename = useCallback(
    async (node: TreeNode, newName: string) => {
      setRenaming(null);
      if (node.note) {
        // A page rename is a move of the page AND its sub-pages (server-side, CAS).
        const next = renamePath(node.note.path, newName);
        if (next) await actions.move(pageRef(node), { newPath: next });
        return;
      }
      try {
        // Rename folder = update path prefix for all notes inside, anchored at the start.
        const oldPrefix = node.rawPath;
        const newPrefix = oldPrefix.includes("/") ? oldPrefix.replace(/\/[^/]+$/, `/${newName}`) : newName;
        for (const n of collectNotes(node)) {
          if (!n.path?.startsWith(oldPrefix)) continue;
          await updateNote.mutateAsync({ id: n.id, path: newPrefix + n.path.slice(oldPrefix.length) });
        }
      } catch (e) {
        console.error("Rename failed:", e);
      }
      invalidate();
    },
    [updateNote, invalidate, actions],
  );

  const handleFolderMove = useCallback(
    async (node: TreeNode, destPath: string) => {
      // Close the dialog IMMEDIATELY and refuse concurrent runs (a folder move is
      // many sequential PATCHes; repeat clicks stacked duplicate move storms).
      setMoveFolder(null);
      if (movingRef.current) return;
      movingRef.current = true;
      try {
        const rootPrefix = node.rawPath.startsWith("vault/") ? "vault/" : "";
        const inside = collectNotes(node).filter((n) => n.path?.startsWith(node.rawPath));
        setMoveProgress({ done: 0, total: inside.length });
        let done = 0;
        for (const n of inside) {
          const relativePath = n.path!.slice(node.rawPath.length);
          const newPath = destPath ? `${destPath}/${node.name}${relativePath}` : `${rootPrefix}${node.name}${relativePath}`;
          await updateNote.mutateAsync({ id: n.id, path: newPath });
          setMoveProgress({ done: ++done, total: inside.length });
        }
      } finally {
        movingRef.current = false;
        setMoveProgress(null);
      }
      invalidate();
    },
    [updateNote, invalidate],
  );

  const handleFolderTrash = useCallback(
    async (node: TreeNode) => {
      setTrashFolder(null);
      for (const n of topPages(node)) await actions.trash({ id: n.id, path: n.path, title: n.path?.split("/").pop() ?? n.id });
    },
    [actions],
  );

  // ─── Drag to reorder / reparent ──────────────────
  const canDropOn = (target: TreeNode, dragged: TreeNode) =>
    target !== dragged && !(dragged.note?.path && (target.rawPath === dragged.note.path || isUnder(target.rawPath, dragged.note.path))) && !protectionReason({ path: target.rawPath });

  const siblingsOf = (parentRaw: string): TreeNode[] => {
    if (!parentRaw || parentRaw === "vault") return tree;
    return findNode(tree, (n) => n.rawPath === parentRaw)?.children ?? [];
  };

  const handleDrop = async (target: TreeNode, zone: DropZone) => {
    const dragged = drag?.node;
    setDrag(null);
    if (!dragged?.note?.path || !canDropOn(target, dragged)) return;
    const page = pageRef(dragged);
    const currentParent = parentOf(dragged.note.path);
    if (zone === "inside" || !target.note) {
      if (target.rawPath !== currentParent) await actions.move(page, { parent: target.rawPath });
      return;
    }
    const parent = parentOf(target.rawPath);
    if (parent !== currentParent) {
      if ((await actions.move(page, { parent })) !== "moved") return;
    }
    const siblings = siblingsOf(parent).filter((n) => n.note);
    const writes = planReorder(
      siblings.map((n) => ({ id: n.note!.id, order: orderOf(n.note!) })),
      dragged.note.id,
      target.note.id,
      zone,
    );
    for (const w of writes) await actions.reorder({ id: w.id, path: null, title: "" }, w.order);
  };

  // ─── Multi-select click handler ──────────────────
  const handleNodeClick = useCallback(
    (e: React.MouseEvent, node: TreeNode): boolean => {
      if (!node.note) return false;
      const noteId = node.note.id;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(noteId)) next.delete(noteId);
          else next.add(noteId);
          return next;
        });
        setLastClickedId(noteId);
        return true;
      }
      if (e.shiftKey && lastClickedId) {
        e.preventDefault();
        const flatIds = getFlatNoteIds(tree);
        const a = flatIds.indexOf(lastClickedId);
        const b = flatIds.indexOf(noteId);
        if (a !== -1 && b !== -1) setSelectedIds(new Set(flatIds.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return true;
      }
      setSelectedIds(new Set());
      setLastClickedId(noteId);
      return false;
    },
    [lastClickedId, tree],
  );

  const handleBatchTrash = useCallback(async () => {
    setBatchTrashConfirm(false);
    const byId = new Map((notes ?? []).map((n) => [n.id, n]));
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    // Skip a page whose ancestor page is also selected: trashing the ancestor takes it along.
    const paths = ids.map((id) => byId.get(id)?.path).filter((p): p is string => !!p);
    for (const id of ids) {
      const n = byId.get(id);
      if (!n || (n.path && paths.some((p) => isUnder(n.path, p)))) continue;
      await actions.trash({ id, path: n.path, title: n.path?.split("/").pop() ?? id });
    }
  }, [selectedIds, notes, actions]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={16} />
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
        No pages yet. Use New page to start one.
      </div>
    );
  }

  return (
    <>
      {moveProgress && (
        <div className="px-3 py-2 border-b text-xs" role="status" style={{ background: "var(--glass)", borderColor: "var(--glass-border)" }}>
          <div className="flex items-center gap-2 mb-1">
            <Spinner size={12} />
            <span style={{ color: "var(--text-secondary)" }}>
              Moving {moveProgress.done} / {moveProgress.total}
            </span>
          </div>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b text-xs" style={{ background: "var(--glass)", borderColor: "var(--glass-border)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{selectedIds.size} selected</span>
          <button onClick={() => setBatchTrashConfirm(true)} className="px-2 py-1 rounded" style={{ color: "var(--color-danger)" }}>
            Move to Trash
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="ml-auto" style={{ color: "var(--text-muted)" }}>
            Clear
          </button>
        </div>
      )}

      <div className="py-0.5">
        {tree.map((node) => (
          <TreeNodeView
            key={rawKey(node)}
            node={node}
            depth={0}
            ctx={{
              onContextMenu: handleContextMenu,
              renamingNode: renaming,
              onRenameConfirm: handleRename,
              onRenameCancel: () => setRenaming(null),
              newFolder,
              onNewFolderConfirm: handleNewFolderConfirm,
              onNewFolderCancel: () => setNewFolder(null),
              selectedIds,
              onNodeClick: handleNodeClick,
              onAddInside: (n) => {
                if (n.note) usePagesUI.getState().openCreate({ folder: n.note.path ?? n.rawPath });
                else setCreationFolder(n.rawPath);
              },
              onMenu: (n, el) => {
                contextTrigger.current = el;
                const r = el.getBoundingClientRect();
                if (n.note) {
                  if (isMobile) usePagesUI.getState().openActions(pageRef(n));
                  else setPageMenu({ x: r.left, y: r.bottom + 4, node: n });
                } else setFolderMenu({ x: r.left, y: r.bottom + 4, node: n });
              },
              drag,
              setDrag,
              canDropOn,
              onDrop: (n, z) => void handleDrop(n, z),
              isMobile,
            }}
          />
        ))}
      </div>

      {creationFolder !== null && <NewContentMenu initialFolder={creationFolder} returnFocus={contextTrigger.current} onClose={() => setCreationFolder(null)} />}

      {folderMenu && (
        <FolderMenu
          state={folderMenu}
          onClose={() => setFolderMenu(null)}
          onNewFolder={(n) => {
            usePagesUI.getState().toggleExpanded(n.rawPath, true);
            setNewFolder({ parentPath: n.rawPath });
          }}
          onNewNote={(n) => setCreationFolder(n.rawPath)}
          onRename={(n) => setRenaming(n)}
          onMove={(n) => setMoveFolder(n)}
          onDelete={(n) => setTrashFolder(n)}
          onSyncToGitFork={(n) => setGitForkSyncPath(n.rawPath)}
        />
      )}
      {pageMenu && <TreePageMenu node={pageMenu.node} at={pageMenu} onRename={() => setRenaming(pageMenu.node)} onClose={() => {
        setPageMenu(null);
        contextTrigger.current?.focus({ preventScroll: true });
      }} />}

      {moveFolder && <FolderMoveDialog node={moveFolder} allPaths={dirPaths} onMove={(dest) => handleFolderMove(moveFolder, dest)} onClose={() => setMoveFolder(null)} />}

      {trashFolder && (
        <ConfirmDialog
          title={`Move “${trashFolder.name}” to Trash?`}
          body={`${collectNotes(trashFolder).length} page${collectNotes(trashFolder).length === 1 ? "" : "s"} inside will move to the Trash. You can restore them from the Trash.`}
          confirm="Move to Trash"
          onConfirm={() => void handleFolderTrash(trashFolder)}
          onCancel={() => setTrashFolder(null)}
        />
      )}
      {batchTrashConfirm && (
        <ConfirmDialog
          title={`Move ${selectedIds.size} pages to Trash?`}
          body="Their sub-pages move with them. You can restore them from the Trash."
          confirm="Move to Trash"
          onConfirm={() => void handleBatchTrash()}
          onCancel={() => setBatchTrashConfirm(false)}
        />
      )}

      {githubSyncPath && <GitHubSyncModal isOpen={true} onClose={() => setGitForkSyncPath(null)} vaultPath={githubSyncPath} />}
    </>
  );
}

function TreePageMenu({ node, at, onRename, onClose }: { node: TreeNode; at: { x: number; y: number }; onRename: () => void; onClose: () => void }) {
  const items = usePageMenuItems(pageRef(node), { entry: node.note, onRename, close: onClose });
  return <PageMenuPopover label={`Actions for ${node.name}`} items={items} anchor={at} onClose={onClose} />;
}

interface TreeCtx {
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  renamingNode: TreeNode | null;
  onRenameConfirm: (node: TreeNode, newName: string) => void;
  onRenameCancel: () => void;
  newFolder: { parentPath: string } | null;
  onNewFolderConfirm: (name: string) => void;
  onNewFolderCancel: () => void;
  selectedIds: Set<string>;
  onNodeClick: (e: React.MouseEvent, node: TreeNode) => boolean;
  onAddInside: (node: TreeNode) => void;
  onMenu: (node: TreeNode, el: HTMLElement) => void;
  drag: { node: TreeNode; over: string | null; zone: DropZone | null } | null;
  setDrag: (d: { node: TreeNode; over: string | null; zone: DropZone | null } | null) => void;
  canDropOn: (target: TreeNode, dragged: TreeNode) => boolean;
  onDrop: (target: TreeNode, zone: DropZone) => void;
  isMobile: boolean;
}

function TreeNodeView({ node, depth, ctx }: { node: TreeNode; depth: number; ctx: TreeCtx }) {
  const open = usePagesUI((s) => !!s.expanded[node.rawPath]);
  const toggle = () => usePagesUI.getState().toggleExpanded(node.rawPath);
  const openTab = useUIStore((s) => s.openTab);
  const active = useUIStore((s) => !!node.note && s.openTabs.find((t) => t.id === s.activeTabId)?.noteId === node.note.id);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const isPage = !!node.note;
  const hasChildren = node.children.length > 0;
  const isRenaming = ctx.renamingNode === node || (!!ctx.renamingNode && rawKey(ctx.renamingNode) === rawKey(node));
  const showNewFolderInput = ctx.newFolder?.parentPath === node.rawPath && !isPage;
  const isSelected = isPage && ctx.selectedIds.has(node.note!.id);
  const contentType = node.note ? inferContentType(node.note) : "document";
  const emoji = typeof node.note?.metadata?.icon === "string" ? (node.note.metadata.icon as string) : null;
  const Icon = isPage ? TYPE_ICONS[contentType] ?? FileText : open ? FolderOpen : Folder;
  const key = rawKey(node);
  const dropHere = ctx.drag && ctx.drag.over === key ? ctx.drag.zone : null;

  const handleClick = (e: React.MouseEvent) => {
    if (longPress.current?.fired) {
      longPress.current = null;
      return;
    }
    if (!isPage) {
      toggle();
      return;
    }
    if (ctx.onNodeClick(e, node)) return;
    openTab(node.note!.id, node.name, contentType);
  };

  const zoneFor = (e: React.DragEvent): DropZone => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    if (!isPage) return "inside";
    return y < r.height * 0.28 ? "before" : y > r.height * 0.72 ? "after" : "inside";
  };

  return (
    <div data-depth={depth}>
      <div
        className="page-tree-row"
        data-active={active || undefined}
        data-selected={isSelected || undefined}
        data-drop={dropHere ?? undefined}
        data-dragging={ctx.drag?.node === node || undefined}
        style={{ paddingLeft: 4 + depth * 14 }}
        draggable={isPage && !isRenaming && !ctx.isMobile}
        onDragStart={(e) => {
          if (!isPage) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.note!.id);
          ctx.setDrag({ node, over: null, zone: null });
        }}
        onDragOver={(e) => {
          if (!ctx.drag || !ctx.canDropOn(node, ctx.drag.node)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const zone = zoneFor(e);
          if (ctx.drag.over !== key || ctx.drag.zone !== zone) ctx.setDrag({ ...ctx.drag, over: key, zone });
        }}
        onDragLeave={(e) => {
          if (ctx.drag?.over === key && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) ctx.setDrag({ ...ctx.drag, over: null, zone: null });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (ctx.drag) ctx.onDrop(node, zoneFor(e));
        }}
        onDragEnd={() => ctx.setDrag(null)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="page-tree-disclosure focus-ring"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
            onClick={toggle}
            tabIndex={-1}
          >
            <ChevronRight size={13} />
          </button>
        ) : (
          <span className="page-tree-spacer" />
        )}
        {isRenaming ? (
          <div className="flex-1 min-w-0 pr-2">
            <InlineEdit label={`Rename ${node.name}`} initialValue={node.name} onConfirm={(val) => ctx.onRenameConfirm(node, val)} onCancel={ctx.onRenameCancel} />
          </div>
        ) : (
          <button
            type="button"
            onClick={handleClick}
            onContextMenu={(e) => ctx.onContextMenu(e, node)}
            onKeyDown={(e) => {
              if (hasChildren && e.key === "ArrowRight" && !open) {
                e.preventDefault();
                usePagesUI.getState().toggleExpanded(node.rawPath, true);
              } else if (hasChildren && e.key === "ArrowLeft" && open) {
                e.preventDefault();
                usePagesUI.getState().toggleExpanded(node.rawPath, false);
              }
            }}
            onPointerDown={(e) => {
              if (e.pointerType !== "touch" || !isPage) return;
              const el = e.currentTarget;
              longPress.current = {
                fired: false,
                timer: setTimeout(() => {
                  if (longPress.current) longPress.current.fired = true;
                  ctx.onMenu(node, el);
                }, 520),
              };
            }}
            onPointerUp={() => longPress.current && !longPress.current.fired && (clearTimeout(longPress.current.timer), (longPress.current = null))}
            onPointerMove={() => longPress.current && !longPress.current.fired && (clearTimeout(longPress.current.timer), (longPress.current = null))}
            onPointerCancel={() => longPress.current && (clearTimeout(longPress.current.timer), (longPress.current = null))}
            className="page-tree-open focus-ring"
            aria-current={active ? "page" : undefined}
          >
            <span className="page-tree-icon">{emoji ? <span className="page-tree-emoji">{emoji}</span> : <Icon size={14} style={{ opacity: 0.75 }} />}</span>
            <span>{node.name}</span>
          </button>
        )}
        {!isRenaming && (
          <span className="page-tree-actions">
            {!protectionReason({ path: node.rawPath }) && (
              <button
                type="button"
                className="page-tree-action focus-ring"
                title={isPage ? "Add a page inside" : "New page in folder"}
                aria-label={`${isPage ? "Add a page inside" : "New page in"} ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.onAddInside(node);
                }}
              >
                <Plus size={14} />
              </button>
            )}
            <button
              type="button"
              className="page-tree-action focus-ring"
              title={isPage ? "Page actions" : "Folder actions"}
              aria-label={`${isPage ? "Page" : "Folder"} actions for ${node.name}`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onMenu(node, e.currentTarget);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </span>
        )}
      </div>
      {open && (hasChildren || showNewFolderInput) && (
        <div>
          {showNewFolderInput && (
            <div className="flex items-center gap-1.5 py-1" style={{ paddingLeft: `${24 + (depth + 1) * 14}px` }}>
              <FolderPlus size={14} className="flex-shrink-0" style={{ opacity: 0.7, color: "var(--text-secondary)" }} />
              <InlineEdit label="Folder name" initialValue="New folder" onConfirm={ctx.onNewFolderConfirm} onCancel={ctx.onNewFolderCancel} />
            </div>
          )}
          {node.children.map((child) => (
            <TreeNodeView key={rawKey(child)} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}
