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
      label: note.path?.split("/").pop() || note.id,
      sublabel: note.path || "",
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: "rgba(0, 0, 0, 0.5)" }}
      onClick={closeCommandBar}
    >
      <div
        className="glass-elevated rounded-xl w-[560px] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <Search size={18} style={{ color: "var(--text-muted)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search, create, or ask Claude..."
            className="flex-1 bg-transparent outline-none text-base"
            style={{ color: "var(--text-primary)" }}
          />
          <kbd className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--glass)", color: "var(--text-muted)" }}>
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-auto py-1">
          {/* Commands */}
          {filteredCommands.length > 0 && (
            <div>
              <div className="px-4 py-1 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Commands
              </div>
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors"
                  style={{
                    background: selectedIndex === i ? "var(--glass-hover)" : "transparent",
                    color: "var(--text-primary)",
                  }}
                >
                  <span style={{ color: "var(--text-secondary)" }}>{cmd.icon}</span>
                  {cmd.label}
                </button>
              ))}
            </div>
          )}

          {/* Vault search results */}
          {vaultItems.length > 0 && (
            <div>
              <div className="px-4 py-1 text-xs font-medium mt-1" style={{ color: "var(--text-muted)" }}>
                Notes
              </div>
              {vaultItems.map((item, i) => {
                const idx = filteredCommands.length + i;
                return (
                  <button
                    key={item.id}
                    onClick={item.action}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className="w-full flex items-start gap-3 px-4 py-2 text-sm transition-colors"
                    style={{
                      background: selectedIndex === idx ? "var(--glass-hover)" : "transparent",
                      color: "var(--text-primary)",
                    }}
                  >
                    <FileText size={15} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} />
                    <div className="text-left min-w-0">
                      <div className="truncate">{item.label}</div>
                      <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                        {item.sublabel}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Ask Claude fallthrough */}
          {query.trim() && (
            <div className="px-4 py-1 mt-1" style={{ borderTop: "1px solid var(--glass-border)" }}>
              <button
                onMouseEnter={() => setSelectedIndex(filteredCommands.length + vaultItems.length)}
                className="w-full flex items-center gap-3 px-0 py-2 text-sm"
                style={{
                  background: selectedIndex === filteredCommands.length + vaultItems.length
                    ? "var(--glass-hover)" : "transparent",
                  color: "var(--color-accent)",
                }}
              >
                <Bot size={15} />
                Ask Claude: "{query}"
                <ArrowRight size={13} className="ml-auto" />
              </button>
            </div>
          )}

          {/* Empty state */}
          {filteredCommands.length === 0 && vaultItems.length === 0 && !query.trim() && (
            <div className="px-4 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Type to search or create
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
