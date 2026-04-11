import { useState, useMemo } from "react";
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
} from "lucide-react";
import { useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { ContentType, Note } from "../../lib/types";
import { Spinner } from "../ui/Spinner";
import { cn } from "../../lib/cn";

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
};

// Build a tree from flat notes list
interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  note?: Note;
}

// Paths to hide from the project tree (templates, staging pipeline)
const HIDDEN_PREFIXES = ["_templates", "_staging"];

// Normalize a vault path: strip "vault/" prefix, clean up display
function normalizePath(path: string): string {
  // Strip leading "vault/" prefix
  if (path.startsWith("vault/")) {
    path = path.slice(6);
  }
  return path;
}

function buildTree(notes: Note[]): TreeNode[] {
  const root: TreeNode = { name: "", fullPath: "", children: [] };

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
        child = { name: part, fullPath: parts.slice(0, i + 1).join("/"), children: [] };
        current.children.push(child);
      }
      current = child;
    }

    const leafName = parts[parts.length - 1];
    current.children.push({
      name: leafName,
      fullPath: normalized,
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

export function ProjectTree() {
  const { data: notes, isLoading } = useNotes();
  const tree = useMemo(() => buildTree(notes || []), [notes]);

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
    <div className="py-0.5">
      {tree.map((node) => (
        <TreeNodeView key={node.fullPath} node={node} depth={0} />
      ))}
    </div>
  );
}

function TreeNodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const openTab = useUIStore((s) => s.openTab);
  const isFolder = !node.note && node.children.length > 0;

  const handleClick = () => {
    if (isFolder) {
      setOpen(!open);
    } else if (node.note) {
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

  return (
    <div>
      <button
        onClick={handleClick}
        className={cn(
          "w-full flex items-center gap-1.5 py-1 text-sm hover:bg-[var(--glass-hover)] transition-colors truncate",
        )}
        style={{
          paddingLeft: `${12 + depth * 16}px`,
          color: "var(--text-secondary)",
        }}
      >
        {IconComponent ? <IconComponent size={14} className="flex-shrink-0" style={{ opacity: 0.7 }} /> : null}
        <span className="truncate">{node.name}</span>
      </button>
      {isFolder && open && (
        <div>
          {node.children.map((child) => (
            <TreeNodeView key={child.fullPath + (child.note?.id || "")} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
