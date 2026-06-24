import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Search, FileText, MonitorPlay, Code, Mail, Table2, Globe,
  CheckSquare, Bot, ArrowRight, Settings, RefreshCw, Wand2,
} from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useVaultSearch, useCreateNote } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { useDebounce } from "use-debounce";
import { CONTENT_DEFAULTS, type ContentType } from "../../lib/types";
import { invoke } from "@tauri-apps/api/core";

interface Command {
  id: string;
  label: string;
  category: "create" | "navigate" | "sync" | "transform" | "agent";
  icon: React.ReactNode;
  action: () => void;
}

export function CommandBar() {
  const { commandBarOpen, closeCommandBar, openTab } = useUIStore();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebounce(query, 200);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const createNote = useCreateNote();

  const { data: searchResults } = useVaultSearch(debouncedQuery);

  useEffect(() => {
    if (commandBarOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandBarOpen]);

  // Build command list
  const createCommand = useCallback((type: ContentType, label: string, icon: React.ReactNode) => ({
    id: `create-${type}`,
    label: `New ${label}`,
    category: "create" as const,
    icon,
    action: async () => {
      const defaults = CONTENT_DEFAULTS[type];
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const title = `Untitled ${label} ${ts}`;
      const note = await createNote.mutateAsync({
        content: defaults.content || " ",
        metadata: defaults.metadata,
        path: title,
      });
      openTab(note.id, title, type);
      closeCommandBar();
    },
  }), [createNote, openTab, closeCommandBar]);

  const { toggleContextPanel, setContextPanelTab, openTabs, activeTabId } = useUIStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  const commands: Command[] = useMemo(() => [
    // Create commands
    createCommand("document", "Document", <FileText size={15} />),
    createCommand("presentation", "Presentation", <MonitorPlay size={15} />),
    createCommand("code", "Code File", <Code size={15} />),
    createCommand("email", "Email", <Mail size={15} />),
    createCommand("spreadsheet", "Spreadsheet", <Table2 size={15} />),
    createCommand("website", "Website", <Globe size={15} />),
    createCommand("task", "Task", <CheckSquare size={15} />),
    // Utility commands
    {
      id: "settings", label: "Settings", category: "navigate" as const,
      icon: <Settings size={15} />,
      action: () => { closeCommandBar(); /* Settings button in TabBar handles this */ },
    },
    {
      id: "agent-panel", label: "Open Agent Panel", category: "navigate" as const,
      icon: <Bot size={15} />,
      action: () => { setContextPanelTab("agent"); toggleContextPanel(); closeCommandBar(); },
    },
    // Sync commands (only show when a note is open)
    ...(activeTab ? [
      {
        id: "sync-notion", label: "Sync to Notion", category: "sync" as const,
        icon: <RefreshCw size={15} />,
        action: async () => {
          await invoke("sync_add_config", { noteId: activeTab.noteId, adapter: "notion" });
          await invoke("sync_trigger", { noteId: activeTab.noteId });
          closeCommandBar();
        },
      },
    ] : []),
    // Transform commands (only show when a note is open)
    ...(activeTab ? [
      {
        id: "transform-presentation", label: "Turn into Presentation", category: "transform" as const,
        icon: <Wand2 size={15} />,
        action: async () => {
          const content = await invoke<string>("agent_transform", {
            noteId: activeTab.noteId, targetType: "presentation",
          });
          const note = await createNote.mutateAsync({
            content,
            metadata: { type: "presentation", aspectRatio: "16:9", theme: "dark" },
            path: `${activeTab.title} (slides)`,
          });
          openTab(note.id, `${activeTab.title} (slides)`, "presentation");
          closeCommandBar();
        },
      },
      {
        id: "transform-email", label: "Turn into Email Draft", category: "transform" as const,
        icon: <Wand2 size={15} />,
        action: async () => {
          const content = await invoke<string>("agent_transform", {
            noteId: activeTab.noteId, targetType: "email",
          });
          const note = await createNote.mutateAsync({
            content,
            metadata: { type: "email", status: "draft", from: "", to: [], subject: "" },
            path: `${activeTab.title} (email)`,
          });
          openTab(note.id, `${activeTab.title} (email)`, "email");
          closeCommandBar();
        },
      },
      {
        id: "resolve-wikilinks", label: "Resolve Wikilinks in This Note", category: "sync" as const,
        icon: <RefreshCw size={15} />,
        action: async () => {
          const result = await invoke<{ resolved: number; total: number }>("resolve_wikilinks", {
            noteId: activeTab.noteId,
          });
          alert(`Resolved ${result.resolved} of ${result.total} wikilinks`);
          closeCommandBar();
        },
      },
    ] : []),
    // Global utility
    {
      id: "resolve-all-wikilinks", label: "Resolve All Wikilinks (Vault-wide)", category: "sync" as const,
      icon: <RefreshCw size={15} />,
      action: async () => {
        const result = await invoke<{ total_wikilinks: number; resolved: number; unresolved: number }>(
          "resolve_all_wikilinks",
        );
        alert(`Processed ${result.total_wikilinks} wikilinks: ${result.resolved} resolved, ${result.unresolved} unresolved`);
        closeCommandBar();
      },
    },
  ], [createCommand, activeTab, closeCommandBar, toggleContextPanel, setContextPanelTab, createNote, openTab]);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  // Vault search results as items
  const vaultItems = useMemo(() => {
    return (searchResults || []).slice(0, 8).map((note) => ({
      id: `note-${note.id}`,
      label: note.path?.split("/").pop()?.replace(/\.[^.]+$/, "") || note.id,
      sublabel: (note.path || "").replace(/^vault\//, ""),
      icon: typeof note.metadata?.icon === "string" ? (note.metadata.icon as string) : null,
      preview: note.content.slice(0, 80),
      action: () => {
        const type = inferContentType(note);
        const title = note.path?.split("/").pop() || note.id;
        openTab(note.id, title, type);
        closeCommandBar();
      },
    }));
  }, [searchResults, openTab, closeCommandBar]);

  // Total items for keyboard navigation
  const totalItems = filteredCommands.length + vaultItems.length + (query.trim() ? 1 : 0); // +1 for "Ask Claude"

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeCommandBar();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, totalItems - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      executeSelected();
    }
  };

  const executeSelected = () => {
    if (selectedIndex < filteredCommands.length) {
      filteredCommands[selectedIndex].action();
    } else if (selectedIndex < filteredCommands.length + vaultItems.length) {
      vaultItems[selectedIndex - filteredCommands.length].action();
    }
    // else: Ask Claude — future
  };

  if (!commandBarOpen) return null;

  const askIdx = filteredCommands.length + vaultItems.length;

  return (
    <div
      className="fixed inset-0 flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: "var(--z-modal)", paddingTop: "14vh", paddingLeft: 16, paddingRight: 16 }}
      onClick={closeCommandBar}
    >
      <div
        className="glass-elevated overflow-hidden"
        style={{ width: "min(600px, 100%)", borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3" style={{ padding: "13px 16px", borderBottom: "1px solid var(--glass-border)" }}>
          <Search size={18} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search notes, create, or ask Claude…"
            className="flex-1 bg-transparent outline-none"
            style={{ color: "var(--text-primary)", fontSize: "var(--text-lg)" }}
          />
          <kbd>esc</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: "min(440px, 56vh)", overflowY: "auto", padding: 6 }}>
          {filteredCommands.length > 0 && (
            <div style={{ marginBottom: 2 }}>
              <div className="text-label" style={{ padding: "6px 10px 4px" }}>Actions</div>
              {filteredCommands.map((cmd, i) => (
                <CmdRow
                  key={cmd.id}
                  selected={selectedIndex === i}
                  onClick={cmd.action}
                  onHover={() => setSelectedIndex(i)}
                  icon={cmd.icon}
                  label={cmd.label}
                />
              ))}
            </div>
          )}

          {vaultItems.length > 0 && (
            <div style={{ marginBottom: 2 }}>
              <div className="text-label" style={{ padding: "6px 10px 4px" }}>Notes</div>
              {vaultItems.map((item, i) => {
                const idx = filteredCommands.length + i;
                return (
                  <CmdRow
                    key={item.id}
                    selected={selectedIndex === idx}
                    onClick={item.action}
                    onHover={() => setSelectedIndex(idx)}
                    icon={item.icon ? <span style={{ fontSize: 17 }}>{item.icon}</span> : <FileText size={15} />}
                    label={item.label}
                    sublabel={item.sublabel}
                  />
                );
              })}
            </div>
          )}

          {query.trim() && (
            <CmdRow
              selected={selectedIndex === askIdx}
              onHover={() => setSelectedIndex(askIdx)}
              icon={<Bot size={15} />}
              label={`Ask Claude: "${query}"`}
              accent
              trailing={<ArrowRight size={13} />}
            />
          )}

          {filteredCommands.length === 0 && vaultItems.length === 0 && !query.trim() && (
            <div style={{ padding: "28px 16px", textAlign: "center", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
              Type to search or create
            </div>
          )}
        </div>

        {/* Footer keyboard hints */}
        <div
          className="flex items-center gap-4"
          style={{ padding: "8px 14px", borderTop: "1px solid var(--glass-border)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        >
          <span className="flex items-center gap-1"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↵</kbd> open</span>
          <span className="flex items-center gap-1"><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/** A single command-palette row: quiet at rest, surface-fill when selected. */
function CmdRow({
  selected,
  onClick,
  onHover,
  icon,
  label,
  sublabel,
  accent,
  trailing,
}: {
  selected: boolean;
  onClick?: () => void;
  onHover: () => void;
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  accent?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      onMouseEnter={onHover}
      className="interactive flex items-center gap-3"
      style={{
        padding: "8px 10px",
        minHeight: 40,
        color: accent ? "var(--color-accent)" : "var(--text-primary)",
        background: selected ? "var(--surface-active)" : undefined,
      }}
    >
      <span
        className="flex items-center justify-center flex-shrink-0"
        style={{ width: 22, height: 22, color: accent ? "var(--color-accent)" : "var(--text-secondary)" }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate" style={{ fontSize: "var(--text-base)" }}>{label}</div>
        {sublabel && (
          <div className="truncate" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{sublabel}</div>
        )}
      </div>
      {trailing && <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{trailing}</span>}
    </div>
  );
}
