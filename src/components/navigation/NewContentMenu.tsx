import { useState, useMemo } from "react";
import {
  FileText,
  Presentation,
  Code,
  MessageSquare,
  Table2,
  Globe,
  CheckSquare,
  LayoutDashboard,
  PenTool,
} from "lucide-react";
import { useCreateNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { useVaultPaths } from "../../app/hooks/useParachute";
import { CONTENT_DEFAULTS, type ContentType } from "../../lib/types";
import { TaskCreateDialog } from "../tasks/TaskCreateDialog";
import { ComposeMessage } from "../comms/ComposeMessage";

const CONTENT_TYPE_OPTIONS = [
  { type: "document" as ContentType, label: "Document", icon: FileText },
  { type: "presentation" as ContentType, label: "Presentation", icon: Presentation },
  { type: "code" as ContentType, label: "Code File", icon: Code },
  { type: "message" as ContentType, label: "Message", icon: MessageSquare },
  { type: "spreadsheet" as ContentType, label: "Spreadsheet", icon: Table2 },
  { type: "website" as ContentType, label: "Website", icon: Globe },
  { type: "task" as ContentType, label: "Task", icon: CheckSquare },
  { type: "dashboard" as ContentType, label: "Dashboard", icon: LayoutDashboard },
  { type: "canvas" as ContentType, label: "Canvas", icon: PenTool },
];

interface NewContentMenuProps {
  onClose: () => void;
}

export function NewContentMenu({ onClose }: NewContentMenuProps) {
  const createNote = useCreateNote();
  const openTab = useUIStore((s) => s.openTab);
  const { data: allPaths } = useVaultPaths();
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [selectedType, setSelectedType] = useState<ContentType | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [showPathSuggestions, setShowPathSuggestions] = useState(false);

  // Unique directory paths for autocomplete
  const dirPaths = useMemo(() => {
    if (!allPaths) return [];
    const dirs = new Set<string>();
    for (const p of allPaths) {
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return Array.from(dirs).sort();
  }, [allPaths]);

  const filteredPaths = pathInput.length > 0
    ? dirPaths.filter((p) => p.toLowerCase().includes(pathInput.toLowerCase())).slice(0, 6)
    : dirPaths.slice(0, 6);

  const [showCompose, setShowCompose] = useState(false);

  const handleTypeClick = (type: ContentType) => {
    if (type === "task") {
      setShowTaskDialog(true);
      return;
    }
    if (type === ("message" as ContentType)) {
      setShowCompose(true);
      return;
    }
    setSelectedType(type);
    setPathInput("");
  };

  const handleCreate = async () => {
    if (!selectedType) return;
    try {
      const defaults = CONTENT_DEFAULTS[selectedType];
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const name = `Untitled ${selectedType} ${ts}`;
      const path = pathInput ? `${pathInput}/${name}` : name;

      const note = await createNote.mutateAsync({
        content: defaults.content || " ",
        metadata: defaults.metadata,
        path,
      });

      openTab(note.id, name, selectedType);
      onClose();
    } catch (e) {
      console.error("Failed to create note:", e);
      alert(`Failed to create ${selectedType}: ${e}`);
    }
  };

  if (showTaskDialog) {
    return <TaskCreateDialog onClose={onClose} />;
  }

  if (showCompose) {
    return <ComposeMessage onClose={onClose} />;
  }

  // Step 2: path picker for the selected type
  if (selectedType) {
    return (
      <div className="fixed inset-0 z-50" onClick={onClose}>
        <div
          className="absolute bottom-12 left-2 py-2 px-3 glass-elevated"
          style={{ borderRadius: "var(--radius-md)", width: 240 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-medium mb-2" style={{ color: "var(--text-primary)" }}>
            Create {selectedType} in...
          </div>
          <div className="relative mb-2">
            <input
              value={pathInput}
              onChange={(e) => { setPathInput(e.target.value); setShowPathSuggestions(true); }}
              onFocus={() => setShowPathSuggestions(true)}
              onBlur={() => setTimeout(() => setShowPathSuggestions(false), 150)}
              placeholder="vault root (or type path)"
              autoFocus
              className="w-full h-7 rounded-md px-2 text-xs outline-none"
              style={{
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-primary)",
              }}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setSelectedType(null); }}
            />
            {showPathSuggestions && filteredPaths.length > 0 && (
              <div
                className="absolute bottom-full left-0 right-0 mb-0.5 py-0.5 rounded-md overflow-hidden max-h-40 overflow-y-auto"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow-elevated)" }}
              >
                {filteredPaths.map((p) => (
                  <button
                    key={p}
                    onMouseDown={() => { setPathInput(p); setShowPathSuggestions(false); }}
                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {p.startsWith("vault/") ? p.slice(6) : p}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedType(null)}
              className="flex-1 px-2 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)]"
              style={{ color: "var(--text-secondary)" }}
            >
              Back
            </button>
            <button
              onClick={handleCreate}
              className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 1: type selector
  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
    >
      <div
        className="absolute bottom-12 left-2 py-1 glass-elevated"
        style={{ borderRadius: "var(--radius-md)", width: 200 }}
        onClick={(e) => e.stopPropagation()}
      >
        {CONTENT_TYPE_OPTIONS.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            onClick={() => handleTypeClick(type)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-primary)" }}
          >
            <Icon size={15} style={{ color: "var(--text-secondary)" }} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
