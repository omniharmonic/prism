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
  Square,
  CheckSquare2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useNotes, useDeleteNote, useUpdateNote, useCreateNote } from "../../app/hooks/useParachute";
import { vaultApi } from "../../lib/parachute/client";
import { GitHubSyncModal } from "../layout/GitHubSyncModal";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { ContentType, Note } from "../../lib/types";
import { Spinner } from "../ui/Spinner";
import { cn } from "../../lib/cn";
import { useQueryClient } from "@tanstack/react-query";

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
};

// Build a tree from flat notes list
interface TreeNode {
  name: string;
  fullPath: string;
  /** The raw vault path (before normalization) — used for operations */
  rawPath: string;
  children: TreeNode[];
  note?: Note;
}

// Paths to hide from the project tree (templates, staging pipeline)
const HIDDEN_PREFIXES = ["_templates", "_staging"];

// Normalize a vault path: strip "vault/" prefix, clean up display
function normalizePath(path: string): string {
  if (path.startsWith("vault/")) {
    path = path.slice(6);
  }
  return path;
}

function buildTree(notes: Note[]): TreeNode[] {
  const root: TreeNode = { name: "", fullPath: "", rawPath: "", children: [] };

  for (const note of notes) {
    const rawPath = note.path || "Unsorted";
    const normalized = normalizePath(rawPath);

    // Filter out hidden paths
    if (HIDDEN_PREFIXES.some((p) => normalized.startsWith(p))) continue;

    const parts = normalized.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let child = current.children.find((c) => c.name === part && !c.note);
      if (!child) {
        const fp = parts.slice(0, i + 1).join("/");
        child = { name: part, fullPath: fp, rawPath: "vault/" + fp, children: [] };
        current.children.push(child);
      }
      current = child;
    }

    const leafName = parts[parts.length - 1];
    current.children.push({
      name: leafName,
      fullPath: normalized,
      rawPath: rawPath,
      children: [],
      note,
    });
  }

  // Sort: folders first, then alphabetical
  function sortTree(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      const aIsFolder = !a.note && a.children.length > 0;
      const bIsFolder = !b.note && b.children.length > 0;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortTree(n.children));
  }
  sortTree(root.children);

  return root.children;
}

/** Collect all note IDs under a tree node (for folder operations) */
function collectNoteIds(node: TreeNode): string[] {
  const ids: string[] = [];
  if (node.note) ids.push(node.note.id);
  for (const child of node.children) ids.push(...collectNoteIds(child));
  return ids;
}

/** Collect all notes under a tree node */
function collectNotes(node: TreeNode): Note[] {
  const notes: Note[] = [];
  if (node.note) notes.push(node.note);
  for (const child of node.children) notes.push(...collectNotes(child));
  return notes;
}

/** Get a flat ordered list of note IDs from the tree (for shift-click range selection) */
function getFlatNoteIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.note) ids.push(node.note.id);
    if (node.children.length > 0) ids.push(...getFlatNoteIds(node.children));
  }
  return ids;
}

// ─── Context Menu ────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

function ContextMenu({
  state,
  onClose,
  onNewFolder,
  onNewNote,
  onRename,
  onMove,
  onDelete,
  onSyncToGitFork,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onNewFolder: (node: TreeNode) => void;
  onNewNote: (node: TreeNode) => void;
  onRename: (node: TreeNode) => void;
  onMove: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  onSyncToGitFork: (node: TreeNode) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isFolder = !state.node.note;

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
    ...(isFolder
      ? [
          { icon: FolderPlus, label: "New folder", action: () => onNewFolder(state.node) },
          { icon: FilePlus, label: "New note", action: () => onNewNote(state.node) },
        ]
      : []),
    { icon: Pencil, label: "Rename", action: () => onRename(state.node) },
    { icon: FolderInput, label: "Move to...", action: () => onMove(state.node) },
    { icon: Trash2, label: "Delete", action: () => onDelete(state.node), danger: true },
    ...(isFolder
      ? [{ icon: GitFork, label: "Sync to GitHub...", action: () => onSyncToGitFork(state.node) }]
      : []),
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 py-1 glass-elevated"
      style={{
        left: state.x,
        top: state.y,
        borderRadius: "var(--radius-md)",
        minWidth: 160,
      }}
    >
      {items.map(({ icon: Icon, label, action, danger }) => (
        <button
          key={label}
          onClick={() => { action(); onClose(); }}
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

function InlineEdit({
  initialValue,
  onConfirm,
  onCancel,
}: {
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const doConfirm = () => {
    if (confirmedRef.current) return; // prevent double-fire (Enter + unmount blur)
    confirmedRef.current = true;
    if (value.trim()) onConfirm(value.trim());
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") doConfirm();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={doConfirm}
      autoFocus
      className="w-full h-6 px-1.5 text-sm rounded outline-none"
      style={{
        background: "var(--glass)",
        border: "1px solid var(--color-accent)",
        color: "var(--text-primary)",
      }}
    />
  );
}

// ─── Move Dialog ─────────────────────────────────────────────

function MoveDialog({
  node,
  allPaths,
  onMove,
  onClose,
}: {
  node: TreeNode;
  allPaths: string[];
  onMove: (destPath: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = allPaths
    .filter((p) => p.toLowerCase().includes(query.toLowerCase()) && p !== node.rawPath)
    .slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div
        className="glass-elevated w-full max-w-sm mx-4 p-4"
        style={{ borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-3" style={{ color: "var(--text-primary)" }}>
          Move "{node.name}" to...
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search folders..."
          autoFocus
          className="w-full h-8 rounded-md px-2.5 text-sm outline-none mb-2"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
        <div className="max-h-48 overflow-auto space-y-0.5">
          {/* Root option */}
          <button
            onClick={() => onMove("vault")}
            className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            / (vault root)
          </button>
          {filtered.map((p) => (
            <button
              key={p}
              onClick={() => onMove(p)}
              className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
              style={{ color: "var(--text-secondary)" }}
            >
              {normalizePath(p)}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirmation ─────────────────────────────────────

function DeleteConfirm({
  node,
  onConfirm,
  onCancel,
}: {
  node: TreeNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isFolder = !node.note;
  const noteCount = isFolder ? collectNoteIds(node).length : 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div
        className="glass-elevated w-full max-w-xs mx-4 p-4"
        style={{ borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-2" style={{ color: "var(--text-primary)" }}>
          Delete {isFolder ? "folder" : "note"}?
        </div>
        <div className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          {isFolder
            ? `This will delete "${node.name}" and ${noteCount} note${noteCount !== 1 ? "s" : ""} inside it.`
            : `This will delete "${node.name}". This cannot be undone.`}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: "var(--color-danger)", color: "white" }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Batch Delete Confirmation ──────────────────────────────

function BatchDeleteConfirm({
  count,
  onConfirm,
  onCancel,
}: {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div
        className="glass-elevated w-full max-w-xs mx-4 p-4"
        style={{ borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-2" style={{ color: "var(--text-primary)" }}>
          Delete {count} notes?
        </div>
        <div className="text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
          This will delete {count} selected note{count !== 1 ? "s" : ""}. This cannot be undone.
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: "var(--color-danger)", color: "white" }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Batch Move Dialog ──────────────────────────────────────

function BatchMoveDialog({
  count,
  allPaths,
  onMove,
  onClose,
}: {
  count: number;
  allPaths: string[];
  onMove: (destPath: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = allPaths
    .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div
        className="glass-elevated w-full max-w-sm mx-4 p-4"
        style={{ borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-3" style={{ color: "var(--text-primary)" }}>
          Move {count} note{count !== 1 ? "s" : ""} to...
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search folders..."
          autoFocus
          className="w-full h-8 rounded-md px-2.5 text-sm outline-none mb-2"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
        <div className="max-h-48 overflow-auto space-y-0.5">
          {/* Root option */}
          <button
            onClick={() => onMove("vault")}
            className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            / (vault root)
          </button>
          {filtered.map((p) => (
            <button
              key={p}
              onClick={() => onMove(p)}
              className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
              style={{ color: "var(--text-secondary)" }}
            >
              {normalizePath(p)}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export function ProjectTree() {
  const { data: notes, isLoading } = useNotes();
  const tree = useMemo(() => buildTree(notes || []), [notes]);
  const queryClient = useQueryClient();
  const deleteNote = useDeleteNote();
  const updateNote = useUpdateNote();
  const createNote = useCreateNote();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<TreeNode | null>(null);
  const [newFolder, setNewFolder] = useState<{ parentPath: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<TreeNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  const [githubSyncPath, setGitForkSyncPath] = useState<string | null>(null);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [batchDeleteProgress, setBatchDeleteProgress] = useState<{ deleted: number; total: number } | null>(null);
  const [batchMoveTarget, setBatchMoveTarget] = useState(false);

  // Gather all unique directory paths for move dialog
  const dirPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const note of notes || []) {
      const p = note.path || "";
      const parts = p.split("/");
      // Add each directory prefix
      for (let i = 1; i < parts.length; i++) {
        paths.add(parts.slice(0, i).join("/"));
      }
    }
    return Array.from(paths).sort();
  }, [notes]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["vault"] });
  }, [queryClient]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  // ─── Operations ──────────────────────────────────

  const handleNewFolder = useCallback((parentNode: TreeNode) => {
    setNewFolder({ parentPath: parentNode.rawPath });
  }, []);

  const handleNewFolderConfirm = useCallback(async (name: string) => {
    if (!newFolder) return;
    const path = `${newFolder.parentPath}/${name}/.keep`;
    await createNote.mutateAsync({ content: " ", path });
    invalidate();
    setNewFolder(null);
  }, [newFolder, createNote, invalidate]);

  const handleNewNote = useCallback(async (parentNode: TreeNode) => {
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const path = `${parentNode.rawPath}/Untitled ${ts}`;
    const note = await createNote.mutateAsync({ content: " ", path });
    const openTab = useUIStore.getState().openTab;
    openTab(note.id, `Untitled ${ts}`, "document");
    invalidate();
  }, [createNote, invalidate]);

  const handleRename = useCallback(async (node: TreeNode, newName: string) => {
    try {
      const isFolder = !node.note;
      if (isFolder) {
        // Rename folder = update path prefix for all notes inside
        const notesInside = collectNotes(node);
        for (const n of notesInside) {
          const oldPrefix = node.rawPath;
          const newPrefix = oldPrefix.replace(/\/[^/]+$/, `/${newName}`);
          const newPath = n.path!.replace(oldPrefix, newPrefix);
          await updateNote.mutateAsync({ id: n.id, path: newPath });
        }
      } else if (node.note) {
        // Rename note = change last path segment
        const parts = node.note.path!.split("/");
        parts[parts.length - 1] = newName;
        await updateNote.mutateAsync({ id: node.note.id, path: parts.join("/") });
        // Update the tab title if this note is open
        useUIStore.getState().renameTab(node.note.id, newName);
      }
    } catch (e) {
      console.error("Rename failed:", e);
    }
    invalidate();
    setRenaming(null);
  }, [updateNote, invalidate]);

  const handleMove = useCallback(async (node: TreeNode, destPath: string) => {
    const isFolder = !node.note;
    if (isFolder) {
      const notesInside = collectNotes(node);
      for (const n of notesInside) {
        const relativePath = n.path!.slice(node.rawPath.length);
        const newPath = `${destPath}/${node.name}${relativePath}`;
        await updateNote.mutateAsync({ id: n.id, path: newPath });
      }
    } else if (node.note) {
      const newPath = `${destPath}/${node.name}`;
      await updateNote.mutateAsync({ id: node.note.id, path: newPath });
    }
    invalidate();
    setMoveTarget(null);
  }, [updateNote, invalidate]);

  const handleDelete = useCallback(async (node: TreeNode) => {
    const ids = node.note ? [node.note.id] : collectNoteIds(node);
    const closeTabs = useUIStore.getState().closeTabs;
    // Close any open tabs for deleted notes
    if (closeTabs) {
      for (const id of ids) closeTabs(id);
    }
    for (const id of ids) {
      await deleteNote.mutateAsync(id);
    }
    invalidate();
    setDeleteTarget(null);
  }, [deleteNote, invalidate]);

  // ─── Multi-select click handler ──────────────────
  const handleNodeClick = useCallback((e: React.MouseEvent, node: TreeNode): boolean => {
    if (!node.note) return false; // folders don't participate in multi-select

    const noteId = node.note.id;

    if (e.metaKey || e.ctrlKey) {
      // Toggle selection
      e.preventDefault();
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(noteId)) next.delete(noteId);
        else next.add(noteId);
        return next;
      });
      setLastClickedId(noteId);
      return true; // signal: handled, don't open
    } else if (e.shiftKey && lastClickedId) {
      // Range select
      e.preventDefault();
      const flatIds = getFlatNoteIds(tree);
      const startIdx = flatIds.indexOf(lastClickedId);
      const endIdx = flatIds.indexOf(noteId);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangeIds = flatIds.slice(from, to + 1);
        setSelectedIds(new Set(rangeIds));
      }
      return true; // signal: handled, don't open
    } else {
      // Normal click — clear selection, let default open behavior run
      setSelectedIds(new Set());
      setLastClickedId(noteId);
      return false; // signal: not handled, proceed with open
    }
  }, [lastClickedId, tree]);

  // ─── Toggle a single note's selection (from checkbox click) ───
  const handleToggleSelect = useCallback((noteId: string, shiftKey?: boolean) => {
    if (shiftKey && lastClickedId) {
      // Range select from last clicked to this one
      const flatIds = getFlatNoteIds(tree);
      const startIdx = flatIds.indexOf(lastClickedId);
      const endIdx = flatIds.indexOf(noteId);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangeIds = flatIds.slice(from, to + 1);
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of rangeIds) next.add(id);
          return next;
        });
      }
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(noteId)) next.delete(noteId);
        else next.add(noteId);
        return next;
      });
    }
    setLastClickedId(noteId);
  }, [lastClickedId, tree]);

  // ─── Batch operations ──────────────────────────────
  const handleBatchDelete = useCallback(async () => {
    const closeTabs = useUIStore.getState().closeTabs;
    const ids = Array.from(selectedIds);

    // Close open tabs for notes being deleted
    if (closeTabs) ids.forEach(id => closeTabs(id));

    setBatchDeleteConfirm(false);
    setBatchDeleteProgress({ deleted: 0, total: ids.length });

    // Listen for progress events from Rust
    const unlisten = await listen<{ deleted: number; failed: number; total: number }>(
      "vault:batch-delete-progress",
      (event) => setBatchDeleteProgress({ deleted: event.payload.deleted, total: event.payload.total }),
    );

    try {
      await vaultApi.batchDelete(ids);
    } finally {
      unlisten();
      setBatchDeleteProgress(null);
      setSelectedIds(new Set());
      invalidate();
    }
  }, [selectedIds, invalidate]);

  const handleBatchMove = useCallback(async (destPath: string) => {
    for (const id of selectedIds) {
      const note = (notes || []).find(n => n.id === id);
      if (!note) continue;
      const name = (note.path || "Untitled").split("/").pop() || "Untitled";
      const newPath = `${destPath}/${name}`;
      await updateNote.mutateAsync({ id, path: newPath });
    }
    setSelectedIds(new Set());
    setBatchMoveTarget(false);
    invalidate();
  }, [selectedIds, notes, updateNote, invalidate]);

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
        No notes in vault
      </div>
    );
  }

  return (
    <>
      {/* Batch delete progress */}
      {batchDeleteProgress && (
        <div className="px-3 py-2 border-b text-xs" style={{ background: "var(--glass)", borderColor: "var(--glass-border)" }}>
          <div className="flex items-center gap-2 mb-1">
            <Spinner size={12} />
            <span style={{ color: "var(--text-secondary)" }}>
              Deleting {batchDeleteProgress.deleted} / {batchDeleteProgress.total}
            </span>
          </div>
          <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${(batchDeleteProgress.deleted / batchDeleteProgress.total) * 100}%`,
                background: "rgb(239,68,68)",
              }}
            />
          </div>
        </div>
      )}

      {/* Batch actions toolbar */}
      {selectedIds.size > 0 && !batchDeleteProgress && (
        <div className="flex items-center gap-2 px-3 py-2 border-b text-xs" style={{ background: "var(--glass)", borderColor: "var(--glass-border)" }}>
          <span style={{ color: "var(--text-secondary)" }}>{selectedIds.size} selected</span>
          <button
            onClick={() => setBatchDeleteConfirm(true)}
            className="px-2 py-1 rounded transition-colors"
            style={{ background: "rgba(239,68,68,0.15)", color: "rgb(252,165,165)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.25)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; }}
          >
            Delete
          </button>
          <button
            onClick={() => setBatchMoveTarget(true)}
            className="px-2 py-1 rounded transition-colors"
            style={{ background: "var(--glass-hover)", color: "var(--text-secondary)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--glass-hover-strong, rgba(255,255,255,0.15))"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--glass-hover)"; }}
          >
            Move to...
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            Clear
          </button>
        </div>
      )}

      <div className="py-0.5">
        {tree.map((node) => (
          <TreeNodeView
            key={node.fullPath}
            node={node}
            depth={0}
            onContextMenu={handleContextMenu}
            renamingNode={renaming}
            onRenameConfirm={handleRename}
            onRenameCancel={() => setRenaming(null)}
            newFolder={newFolder}
            onNewFolderConfirm={handleNewFolderConfirm}
            onNewFolderCancel={() => setNewFolder(null)}
            selectedIds={selectedIds}
            selectionMode={selectedIds.size > 0}
            onToggleSelect={handleToggleSelect}
            onNodeClick={handleNodeClick}
          />
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onNewFolder={handleNewFolder}
          onNewNote={handleNewNote}
          onRename={(n) => setRenaming(n)}
          onMove={(n) => setMoveTarget(n)}
          onDelete={(n) => setDeleteTarget(n)}
          onSyncToGitFork={(n) => setGitForkSyncPath(n.rawPath)}
        />
      )}

      {/* Move dialog (single item) */}
      {moveTarget && (
        <MoveDialog
          node={moveTarget}
          allPaths={dirPaths}
          onMove={(dest) => handleMove(moveTarget, dest)}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {/* Batch move dialog */}
      {batchMoveTarget && (
        <BatchMoveDialog
          count={selectedIds.size}
          allPaths={dirPaths}
          onMove={handleBatchMove}
          onClose={() => setBatchMoveTarget(false)}
        />
      )}

      {/* Delete confirmation (single item) */}
      {deleteTarget && (
        <DeleteConfirm
          node={deleteTarget}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Batch delete confirmation */}
      {batchDeleteConfirm && (
        <BatchDeleteConfirm
          count={selectedIds.size}
          onConfirm={handleBatchDelete}
          onCancel={() => setBatchDeleteConfirm(false)}
        />
      )}

      {/* GitHub sync modal */}
      {githubSyncPath && (
        <GitHubSyncModal
          isOpen={true}
          onClose={() => setGitForkSyncPath(null)}
          vaultPath={githubSyncPath}
        />
      )}
    </>
  );
}

function TreeNodeView({
  node,
  depth,
  onContextMenu,
  renamingNode,
  onRenameConfirm,
  onRenameCancel,
  newFolder,
  onNewFolderConfirm,
  onNewFolderCancel,
  selectedIds,
  selectionMode,
  onToggleSelect,
  onNodeClick,
}: {
  node: TreeNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  renamingNode: TreeNode | null;
  onRenameConfirm: (node: TreeNode, newName: string) => void;
  onRenameCancel: () => void;
  newFolder: { parentPath: string } | null;
  onNewFolderConfirm: (name: string) => void;
  onNewFolderCancel: () => void;
  selectedIds: Set<string>;
  selectionMode: boolean;
  onToggleSelect: (noteId: string, shiftKey?: boolean) => void;
  onNodeClick: (e: React.MouseEvent, node: TreeNode) => boolean;
}) {
  const [open, setOpen] = useState(depth === 0);
  const openTab = useUIStore((s) => s.openTab);
  const isFolder = !node.note && node.children.length > 0;
  const isRenaming = renamingNode?.fullPath === node.fullPath && renamingNode?.note?.id === node.note?.id;
  const showNewFolderInput = newFolder?.parentPath === node.rawPath && isFolder;
  const isSelected = node.note ? selectedIds.has(node.note.id) : false;

  const handleClick = (e: React.MouseEvent) => {
    if (isFolder) {
      setOpen(!open);
      return;
    }
    // In selection mode, clicks toggle selection instead of opening
    if (selectionMode && noteId) {
      onToggleSelect(noteId, e.shiftKey);
      return;
    }
    // Let multi-select handler run first (Cmd/Ctrl + Shift clicks)
    const handled = onNodeClick(e, node);
    if (!handled && node.note) {
      // Normal click — open the note
      const type = inferContentType(node.note);
      openTab(node.note.id, node.name, type);
    }
  };

  const contentType = node.note ? inferContentType(node.note) : "document";

  function getIcon() {
    if (isFolder) return open ? FolderOpen : Folder;
    return TYPE_ICONS[contentType] ?? FileText;
  }

  const IconComponent = getIcon();

  const isNote = !!node.note;
  const showCheckbox = isNote && selectionMode;
  const noteId = node.note?.id;

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (noteId) onToggleSelect(noteId, e.shiftKey);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={cn(
          "group w-full flex items-center gap-1.5 py-1 text-sm hover:bg-[var(--glass-hover)] transition-colors truncate",
          isSelected && "bg-white/10 ring-1 ring-white/20",
        )}
        style={{
          paddingLeft: `${12 + depth * 16}px`,
          color: "var(--text-secondary)",
        }}
      >
        {/* Icon area: checkbox on hover (or always in selection mode) */}
        <span className="relative flex-shrink-0 w-[14px] h-[14px]">
          {isNote && (
            <>
              {/* Normal icon — hidden on hover or in selection mode */}
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center transition-opacity pointer-events-none",
                  showCheckbox ? "opacity-0" : "opacity-100 group-hover:opacity-0",
                )}
              >
                {IconComponent ? <IconComponent size={14} style={{ opacity: 0.7 }} /> : null}
              </span>
              {/* Checkbox — visible on hover or in selection mode, on top for clicks */}
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center z-10",
                  showCheckbox ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
                onClick={handleCheckboxClick}
              >
                {isSelected
                  ? <CheckSquare2 size={14} style={{ color: "var(--accent, #60a5fa)" }} />
                  : <Square size={14} style={{ opacity: 0.5 }} />
                }
              </span>
            </>
          )}
          {!isNote && IconComponent && (
            <IconComponent size={14} style={{ opacity: 0.7 }} />
          )}
        </span>
        {isRenaming ? (
          <InlineEdit
            initialValue={node.name}
            onConfirm={(val) => onRenameConfirm(node, val)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </button>
      {isFolder && open && (
        <div>
          {/* New folder inline input */}
          {showNewFolderInput && (
            <div
              className="flex items-center gap-1.5 py-1"
              style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
            >
              <FolderPlus size={14} className="flex-shrink-0" style={{ opacity: 0.7, color: "var(--text-secondary)" }} />
              <InlineEdit
                initialValue="New folder"
                onConfirm={onNewFolderConfirm}
                onCancel={onNewFolderCancel}
              />
            </div>
          )}
          {node.children.map((child) => (
            <TreeNodeView
              key={child.fullPath + (child.note?.id || "")}
              node={child}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              renamingNode={renamingNode}
              onRenameConfirm={onRenameConfirm}
              onRenameCancel={onRenameCancel}
              newFolder={newFolder}
              onNewFolderConfirm={onNewFolderConfirm}
              onNewFolderCancel={onNewFolderCancel}
              selectedIds={selectedIds}
              selectionMode={selectionMode}
              onToggleSelect={onToggleSelect}
              onNodeClick={onNodeClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
