import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Search, X, FileText, MonitorPlay, Code, Mail, Table2, Globe,
  CheckSquare, MessageSquare, Bot, ArrowRight, Settings, RefreshCw, Wand2, History, Sparkles } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useVaultSearch, useCreateNote } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { useDebounce } from "use-debounce";
import { type ContentType } from "../../lib/types";
import { invoke } from "@tauri-apps/api/core";
import { useAgentAvailable } from "../../data/AgentClientContext";
import { openAgentChat, isAskableNoteId } from "../../lib/agent/chatStore";
import { isDesktop } from "../../lib/platform";
import { useHostServices } from "../../data/HostServicesContext";
import { useVaultClient } from "../../data/VaultClientContext";
import { buildTransformPrompt, hostServiceErrorText, runWikilinkJobToEnd, wikilinkJobSummary } from "../../lib/host/services";
import { addSyncConfig, resolveWikilinks } from "../../lib/host/vaultOps";
import { searchModeLabel, searchPreview, searchResultGroup } from "../navigation/searchPresentation";
import "../navigation/search-workspace.css";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { useNotionDbSyncModal } from "./NotionDbSyncHost";

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
  const [filter, setFilter] = useState<"all" | "notes" | "messages" | "commands">("all");
  const [debouncedQuery] = useDebounce(query, 200);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creationType, setCreationType] = useState<ContentType | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createNote = useCreateNote();
  const isMobile = useIsMobile();
  const agentChat = useAgentAvailable();
  // Host-backed commands: the desktop runs them through Tauri; a thin client
  // (PWA / Prism Client) through the server for its owner (WP4.3). Others get
  // none of them.
  const host = useHostServices();
  const vaultClient = useVaultClient();
  const hostCmds = isDesktop || !!host;

  /** Run a command, surfacing a failure as an alert instead of a silent rejection. */
  const surface = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      alert(hostServiceErrorText(e));
    }
  }, []);

  const transformNote = useCallback(async (noteId: string, targetType: string): Promise<string> => {
    if (isDesktop) return invoke<string>("agent_transform", { noteId, targetType });
    const note = await vaultClient.getNote(noteId);
    return host!.agentText(buildTransformPrompt(note, targetType), { skill: "transform", noteId, timeoutMs: 10 * 60_000 });
  }, [host, vaultClient]);

  const { data: searchResults, mode: searchMode, isFetching: searching, isError: searchFailed, refetch: retrySearch } = useVaultSearch(commandBarOpen ? debouncedQuery : "");

  useEffect(() => {
    if (commandBarOpen) {
      setQuery("");
      setFilter("all");
      setSelectedId(null);
      const previous = document.activeElement as HTMLElement | null;
      returnFocus.current = previous;
      const dialog = dialogRef.current;
      dialog?.showModal();
      inputRef.current?.focus();
      return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
    }
  }, [commandBarOpen]);

  // Build command list
  const createCommand = useCallback((type: ContentType, label: string, icon: React.ReactNode) => ({
    id: `create-${type}`,
    label: `New ${label}`,
    category: "create" as const,
    icon,
    action: () => {
      setCreationType(type);
      closeCommandBar();
    },
  }), [closeCommandBar]);

  const { toggleContextPanel, setContextPanelTab, openTabs, activeTabId } = useUIStore();
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const activeIsNote = isAskableNoteId(activeTab?.noteId);

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
      action: () => { closeCommandBar(); useUIStore.getState().setSettingsOpen(true); },
    },
    {
      id: "agent-panel", label: "Open Agent Panel", category: "navigate" as const,
      icon: <Bot size={15} />,
      action: () => { setContextPanelTab("agent"); if (!useUIStore.getState().contextPanelOpen) toggleContextPanel(); closeCommandBar(); },
    },
    // Server agent sessions (WP3.2) — owner + AgentClient shells only.
    ...(agentChat ? [
      {
        id: "agent-chat", label: "Agent Chat", category: "agent" as const,
        icon: <Sparkles size={15} />,
        action: () => { openAgentChat(); closeCommandBar(); },
      },
      ...(activeIsNote && activeTab ? [{
        id: "agent-ask-note", label: "Ask About This Note", category: "agent" as const,
        icon: <Sparkles size={15} />,
        action: () => {
          openAgentChat({ ask: { noteId: activeTab.noteId, noteTitle: activeTab.title } });
          closeCommandBar();
        },
      }] : []),
    ] : []),
    ...(activeTab && !activeTab.noteId.includes(":") ? [
      {
        id: "version-history", label: "Version History", category: "navigate" as const,
        icon: <History size={15} />,
        action: () => {
          setContextPanelTab("history");
          if (!useUIStore.getState().contextPanelOpen) toggleContextPanel();
          closeCommandBar();
        },
      },
    ] : []),
    // Sync commands (only show when a note is open)
    ...(activeTab && hostCmds ? [
      {
        id: "sync-notion", label: "Sync to Notion", category: "sync" as const,
        icon: <RefreshCw size={15} />,
        action: async () => {
          if (isDesktop) {
            await invoke("sync_add_config", { noteId: activeTab.noteId, adapter: "notion" });
            await invoke("sync_trigger", { noteId: activeTab.noteId });
            closeCommandBar();
            return;
          }
          closeCommandBar();
          await surface(async () => {
            await addSyncConfig(vaultClient, activeTab.noteId, "notion");
            const errors = (await host!.notePush(activeTab.noteId)).filter((r) => r.status === "error");
            if (errors.length) alert(errors.map((r) => r.message).join("; "));
          });
        },
      },
    ] : []),
    // Transform commands (only show when a note is open)
    ...(activeTab && hostCmds ? [
      {
        id: "transform-presentation", label: "Turn into Presentation", category: "transform" as const,
        icon: <Wand2 size={15} />,
        action: () => surface(async () => {
          closeCommandBar();
          const content = await transformNote(activeTab.noteId, "presentation");
          const note = await createNote.mutateAsync({
            content,
            metadata: { type: "presentation", aspectRatio: "16:9", theme: "dark" },
            path: `${activeTab.title} (slides)`,
          });
          openTab(note.id, `${activeTab.title} (slides)`, "presentation");
        }),
      },
      {
        id: "transform-email", label: "Turn into Email Draft", category: "transform" as const,
        icon: <Wand2 size={15} />,
        action: () => surface(async () => {
          closeCommandBar();
          const content = await transformNote(activeTab.noteId, "email");
          const note = await createNote.mutateAsync({
            content,
            metadata: { type: "email", status: "draft", from: "", to: [], subject: "" },
            path: `${activeTab.title} (email)`,
          });
          openTab(note.id, `${activeTab.title} (email)`, "email");
        }),
      },
    ] : []),
    ...(activeTab ? [
      {
        id: "resolve-wikilinks", label: "Resolve Wikilinks in This Note", category: "sync" as const,
        icon: <RefreshCw size={15} />,
        action: async () => {
          closeCommandBar();
          await surface(async () => {
            // Desktop: its Tauri command. Elsewhere: the same algorithm through the
            // VaultClient seam (the gateway applies this user's grants).
            const result = isDesktop
              ? await invoke<{ resolved: number; total: number }>("resolve_wikilinks", { noteId: activeTab.noteId })
              : await resolveWikilinks(vaultClient, activeTab.noteId);
            alert(`Resolved ${result.resolved} of ${result.total} wikilinks`);
          });
        },
      },
    ] : []),
    // Notion database sync setup / management (desktop: Tauri; thin client: the
    // server, owner only — Client parity B).
    ...(hostCmds ? [{
      id: "notion-db-sync", label: "Notion Database Sync…", category: "sync" as const,
      icon: <RefreshCw size={15} />,
      action: () => {
        closeCommandBar();
        useNotionDbSyncModal.getState().setOpen(true);
      },
    }] : []),
    // Vault-wide resolve on a thin client (server owner): the server job
    // (/api/admin/wikilinks/resolve) — a dry run first, then a confirmed write.
    ...(!isDesktop && host ? [{
      id: "resolve-all-wikilinks", label: "Resolve All Wikilinks (Vault-wide)", category: "sync" as const,
      icon: <RefreshCw size={15} />,
      action: async () => {
        closeCommandBar();
        await surface(async () => {
          const dry = await runWikilinkJobToEnd(host, { dryRun: true });
          if (dry.status !== "done") {
            alert(`The wikilink scan ${dry.status}${dry.error ? `: ${dry.error}` : ""}.`);
            return;
          }
          const summary = wikilinkJobSummary(dry);
          if (!dry.resolved) {
            alert(`${summary}\n\nNothing to add.`);
            return;
          }
          if (!confirm(`${summary}\n\nAdd these ${dry.resolved} links now? (Only links are added; note text is never changed.)`)) return;
          const real = await runWikilinkJobToEnd(host, { dryRun: false });
          alert(wikilinkJobSummary(real));
        });
      },
    }] : []),
    // Global utility (desktop: its Tauri command scans every note on the host)
    ...(isDesktop ? [{
      id: "resolve-all-wikilinks", label: "Resolve All Wikilinks (Vault-wide)", category: "sync" as const,
      icon: <RefreshCw size={15} />,
      action: async () => {
        const result = await invoke<{ total_wikilinks: number; resolved: number; unresolved: number }>(
          "resolve_all_wikilinks",
        );
        alert(`Processed ${result.total_wikilinks} wikilinks: ${result.resolved} resolved, ${result.unresolved} unresolved`);
        closeCommandBar();
      },
    }] : []),
  ], [createCommand, activeTab, activeIsNote, agentChat, closeCommandBar, toggleContextPanel, setContextPanelTab, createNote, openTab, hostCmds, host, vaultClient, surface, transformNote]);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    if (filter !== "all" && filter !== "commands") return [];
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query, filter]);

  // Local filters describe the returned accessible set; they do not claim to
  // search a separate message index or paginate the complete vault.
  const vaultItems = useMemo(() => {
    const notes = query.trim() === debouncedQuery.trim() ? searchResults ?? [] : [];
    return notes.filter(note => filter !== "commands" && (filter === "all" || searchResultGroup(note) === filter)).map(note => ({
      id: `note-${note.id}`,
      label: note.path?.split("/").pop() || note.id,
      sublabel: note.path || "Saved note",
      group: searchResultGroup(note),
      icon: typeof note.metadata?.icon === "string" ? note.metadata.icon : null,
      preview: searchPreview(note, 220),
      action: () => { openTab(note.id, note.path?.split("/").pop() || note.id, inferContentType(note)); closeCommandBar(); },
    }));
  }, [searchResults, query, debouncedQuery, filter, openTab, closeCommandBar]);
  const noteItems = vaultItems.filter(item => item.group === "notes");
  const messageItems = vaultItems.filter(item => item.group === "messages");
  const orderedNotes = [...noteItems, ...messageItems];
  const showAsk = !!query.trim() && agentChat && (filter === "all" || filter === "commands");
  const items = [...orderedNotes, ...filteredCommands, ...(showAsk ? [{ id: "ask-agent", action: () => askClaude() }] : [])];
  // Ask is never a default action: Enter while waiting or after zero matches
  // cannot accidentally submit the user's search as an agent prompt.
  const defaultId = orderedNotes[0]?.id ?? filteredCommands[0]?.id;
  const selectedIndex = items.findIndex(item => item.id === (selectedId ?? defaultId));
  const totalItems = items.length;
  useEffect(() => {
    if (commandBarOpen) document.getElementById(`prism-command-${selectedIndex}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [commandBarOpen, selectedIndex, totalItems]);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCommandBar(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.max(0, Math.min(selectedIndex + 1, totalItems - 1)) : Math.max(selectedIndex - 1, 0);
      setSelectedId(items[next]?.id ?? null);
    }
    if (e.key === "Enter") { e.preventDefault(); items[selectedIndex]?.action(); }
  };

  // "Ask Claude: …" → a new server agent session with that prompt (web owner).
  const askClaude = () => {
    const q = query.trim();
    if (!q || !agentChat) return;
    openAgentChat({ ask: { prompt: q } });
    closeCommandBar();
  };

  if (creationType) return <NewContentMenu initialType={creationType} returnFocus={returnFocus.current} onClose={() => setCreationType(null)} />;
  if (!commandBarOpen) return null;

  const searchingNow = searching || query.trim() !== debouncedQuery.trim();
  const inputRow = <div className="prism-search-input-row">
    <Search size={20} aria-hidden="true" />
    <input ref={inputRef} aria-label="Search notes and commands" role="combobox" aria-expanded={true}
      aria-controls="prism-command-results" aria-autocomplete="list"
      aria-activedescendant={selectedIndex >= 0 ? `prism-command-${selectedIndex}` : undefined}
      inputMode="search" enterKeyHint="search" value={query}
      onChange={e => { setQuery(e.target.value); setSelectedId(null); }} onKeyDown={handleKeyDown}
      placeholder="Search your workspace…" />
    <button tabIndex={0} aria-label="Close search" className="focus-ring" onClick={closeCommandBar}><X size={18} /></button>
  </div>;
  const filters = <div className="prism-search-filters" aria-label="Filter search results">
    {([['all', 'All'], ['notes', 'Notes'], ['messages', 'Messages'], ['commands', 'Commands']] as const).map(([id, label]) =>
      <button key={id} tabIndex={0} type="button" aria-pressed={filter === id} className="focus-ring" onClick={() => { setFilter(id); setSelectedId(null); inputRef.current?.focus({ preventScroll: true }); }}>{label}</button>)}
  </div>;
  const status = <div className="prism-search-status" role="status">
    <span>Current workspace</span><span>{!query.trim() ? "Search notes or choose an action" : searchingNow ? "Searching…" : searchFailed ? "Search unavailable" : `${vaultItems.length} results shown · ${searchModeLabel(searchMode)}`}</span>
  </div>;
  const renderNotes = (notes: typeof vaultItems, label: string) => notes.length > 0 && <div role="group" aria-label={label}>
    <div className="prism-search-group">{label}</div>
    {notes.map(item => { const index = items.findIndex(candidate => candidate.id === item.id); return <CmdRow key={item.id} id={`prism-command-${index}`} selected={selectedIndex === index} onClick={item.action} onHover={() => setSelectedId(item.id)}
      icon={item.icon ? <span>{item.icon}</span> : item.group === "messages" ? <MessageSquare size={18} /> : <FileText size={18} />}
      label={item.label} sublabel={item.sublabel} preview={item.preview} trailing={<span className="prism-search-open">Open <ArrowRight size={13} /></span>} />; })}
  </div>;
  const body = <>
    {renderNotes(noteItems, "Notes")}{renderNotes(messageItems, "Messages")}
    {filteredCommands.length > 0 && <div role="group" aria-label="Commands"><div className="prism-search-group">Commands</div>{filteredCommands.map(cmd => {
      const index = items.findIndex(item => item.id === cmd.id);
      return <CmdRow key={cmd.id} id={`prism-command-${index}`} selected={selectedIndex === index} onClick={cmd.action} onHover={() => setSelectedId(cmd.id)} icon={cmd.icon} label={cmd.label} />;
    })}</div>}
    {showAsk && <CmdRow id={`prism-command-${items.length - 1}`} selected={selectedIndex === items.length - 1} onClick={askClaude} onHover={() => setSelectedId("ask-agent")} icon={<Bot size={18} />} label={`Ask your agent: "${query}"`} accent trailing={<ArrowRight size={13} />} />}
  </>;
  const feedback = <>
    {query.trim() && searchFailed && <div role="alert" className="prism-search-feedback">Couldn't search this workspace. <button className="focus-ring" onClick={() => void retrySearch()}>Try again</button></div>}
    {query.trim() && !searchingNow && !searchFailed && !vaultItems.length && filter !== "commands" && <p className="prism-search-feedback">{filter === "messages" ? "No matching messages in these results." : "No matching notes."} <span>Try a name, phrase, or related idea.</span></p>}
    {filter === "commands" && !filteredCommands.length && <p className="prism-search-feedback">No matching commands.</p>}
  </>;
  // Mobile: a floating sheet with the field docked at the bottom (just above the
  // keyboard, Obsidian-style) and results scrolling above it.
  if (isMobile) {
    return (
      <dialog ref={dialogRef} aria-label="Search workspace" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); closeCommandBar(); }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 text-[var(--text-primary)] flex flex-col justify-end"
        style={{ zIndex: "var(--z-modal)" as unknown as number }}
        onClick={closeCommandBar}
      >
        <div className="sheet-backdrop absolute inset-0" style={{ background: "rgba(0,0,0,0.45)" }} />
        <div
          className="prism-search-sheet sheet-panel relative flex flex-col"
          style={{
            margin: "0 8px",
            marginBottom: "calc(env(safe-area-inset-bottom) + 8px)",
            borderRadius: "var(--radius-lg)",
            maxHeight: "78dvh",
            overflow: "hidden",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {filters}{status}{feedback}<div id="prism-command-results" role="listbox" aria-label="Notes and commands" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6 }}>{body}</div>
          {inputRow}
        </div>
      </dialog>
    );
  }

  return (
    <dialog ref={dialogRef} aria-label="Search workspace" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); closeCommandBar(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 text-[var(--text-primary)] flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: "var(--z-modal)", paddingTop: "14vh", paddingLeft: 16, paddingRight: 16 }}
      onClick={closeCommandBar}
    >
      <div
        className="prism-search-sheet modal-rise overflow-hidden"
        style={{ width: "min(780px, 100%)", borderRadius: "var(--radius-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {inputRow}{filters}{status}{feedback}
        <div id="prism-command-results" role="listbox" aria-label="Notes and commands" style={{ maxHeight: "min(440px, 56vh)", overflowY: "auto", padding: 6 }}>{body}</div>

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
    </dialog>
  );
}

/** A single command-palette row: quiet at rest, surface-fill when selected. */
function CmdRow({
  id,
  selected,
  onClick,
  onHover,
  icon,
  label,
  sublabel,
  preview,
  accent,
  trailing,
}: {
  id: string;
  selected: boolean;
  onClick?: () => void;
  onHover: () => void;
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  preview?: string;
  accent?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={selected}
      tabIndex={-1}
      onClick={onClick}
      onMouseEnter={onHover}
      className="prism-search-result interactive focus-ring flex w-full items-center gap-3"
      style={{
        padding: "8px 10px",
        minHeight: 48,
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
        <div className="prism-search-result-title">{label}</div>
        {preview && <div className="mt-1 line-clamp-2 break-words text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>{preview}</div>}
        {sublabel && (
          <div className="truncate" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{sublabel}</div>
        )}
      </div>
      {trailing && <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{trailing}</span>}
    </button>
  );
}
