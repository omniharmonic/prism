import { AddSavedNoteContextButton } from "../agent/SavedNoteHandoff";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Search, X, FileText, MonitorPlay, Code, Mail, Table2, Globe,
  CheckSquare, MessageSquare, Bot, ArrowRight, Settings, RefreshCw, Wand2, History, Sparkles, Trash2, FolderInput, Upload, Download, Printer,
  Star, SunMoon, PanelLeft, PanelRight, ChevronLeft, ChevronRight, FilePlus2, Home as HomeIcon, Inbox as InboxIcon, LayoutTemplate } from "lucide-react";
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
import { searchModeLabel, searchResultGroup } from "../navigation/searchPresentation";
import { Highlighted, resultHighlights } from "../navigation/searchHighlight";
import { EMPTY_FILTERS, SearchFilterBar, activeFilterCount, toSearchFilters, useSearchIdentityFilters, type SearchFilterState } from "../navigation/searchFilters";
import { recentSearches, rememberSearch } from "../navigation/searchRecents";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { Range } from "../../lib/search/match";
import { useQuery } from "@tanstack/react-query";
import { useCollabSharing } from "../../data/CollabSharing";
import "../navigation/search-workspace.css";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { useNotionDbSyncModal } from "./NotionDbSyncHost";
import { transferAvailable } from "../../lib/import-export/client";
import { printCurrentPage, useTransferUI } from "../../lib/import-export/store";
import { useCanManageTransfers } from "../import-export/ImportExportHost";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { usePagesUI } from "../../lib/pages/store";
import { pageAgentReady, requestPageAgent, type PageAgentKind } from "../../lib/agent/pageActions";
import { useDocumentSnapshots } from "../../lib/agent/documentSnapshots";
import { openShortcutSheet } from "../renderers/ShortcutSheet";
import { shortcutKeys } from "../../lib/shortcuts";
import { openInNewTab } from "../../lib/pages/openInNewTab";
import { PageIcon, PageIconView, pageIconOf } from "../../lib/pages/icons";
import { ariaKeys, editedLabel, hint } from "../../lib/shortcutHints";
import { toggleTheme } from "../../app/stores/settings";
import { useVaultTree } from "../../app/hooks/useParachute";

interface Command {
  id: string;
  label: string;
  category: "create" | "navigate" | "sync" | "transform" | "agent";
  icon: React.ReactNode;
  /** Shown at the end of the row (NP-SR-06), e.g. ["mod", "shift", "L"]; the key itself is bound in useKeyboardShortcuts. */
  keys?: string[];
  action: () => void;
}

export function CommandBar() {
  const { commandBarOpen, closeCommandBar, openTab } = useUIStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "notes" | "messages" | "commands">("all");
  const [debouncedQuery] = useDebounce(query, 200);
  const [searchFilters, setSearchFilters] = useState<SearchFilterState>(EMPTY_FILTERS);
  const searchIdentity = useSearchIdentityFilters();
  const wireFilters = useMemo(() => toSearchFilters(searchFilters, searchIdentity), [searchFilters, searchIdentity]);
  const searchScope = useAgentChatStore((s) => s.scope);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  // Vault scope (NP-SR-04): the vaults this account can reach on this server.
  const sharing = useCollabSharing();
  const { data: searchVaults } = useQuery({
    queryKey: ["search-vaults", searchScope],
    enabled: commandBarOpen && !!sharing?.listVaults,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => (await sharing!.listVaults!()).map((v) => ({ id: v.id, label: v.label, active: v.active })),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creationType, setCreationType] = useState<ContentType | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createNote = useCreateNote();
  const isMobile = useIsMobile();
  // Phone search fills the VISUAL viewport (what is left above the keyboard).
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!commandBarOpen || !isMobile || !vv) { setViewportHeight(null); return; }
    const measure = () => setViewportHeight(Math.round(vv.height));
    measure();
    vv.addEventListener("resize", measure);
    return () => vv.removeEventListener("resize", measure);
  }, [commandBarOpen, isMobile]);
  const agentChat = useAgentAvailable();
  const canTransfer = useCanManageTransfers();
  // Host-backed commands: the desktop runs them through Tauri; a thin client
  // (PWA / Prism Client) through the server for its owner (WP4.3). Others get
  // none of them.
  const host = useHostServices();
  const vaultClient = useVaultClient();
  const { recents, favoriteIds, toggleFavorite } = useNoteShortcuts();
  // Edited dates for recent pages come from the (already loaded) sidebar tree.
  const { data: tree } = useVaultTree();
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

  const { data: searchResults, mode: searchMode, isFetching: searching, isError: searchFailed, refetch: retrySearch } = useVaultSearch(commandBarOpen ? debouncedQuery : "", wireFilters);

  useEffect(() => {
    if (commandBarOpen) {
      setQuery("");
      setFilter("all");
      setSearchFilters(EMPTY_FILTERS);
      setRecentQueries(recentSearches(useAgentChatStore.getState().scope));
      setSelectedId(null);
      const previous = document.activeElement as HTMLElement | null;
      returnFocus.current = previous;
      // Opened from inside an editor: remember the caret, because focus() alone
      // puts it back at the start of the document (NP-SB-02).
      const selection = window.getSelection();
      const caret = previous?.isContentEditable && selection?.rangeCount && previous.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
      const dialog = dialogRef.current;
      dialog?.showModal();
      inputRef.current?.focus();
      return () => {
        dialog?.close();
        if (!previous?.isConnected) return;
        previous.focus();
        if (caret && previous.contains(caret.startContainer)) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(caret); }
      };
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
  // Is the page in front open in a text editor? (Re-read when an editor registers or leaves.)
  const activeEditor = useDocumentSnapshots((st) => (activeTab?.noteId ? st.notes[activeTab.noteId]?.editor : undefined));
  const agentReady = !!activeEditor && pageAgentReady(activeTab?.noteId);

  const commands: Command[] = useMemo(() => [
    // Create commands
    createCommand("document", "Document", <FileText size={15} />),
    createCommand("presentation", "Presentation", <MonitorPlay size={15} />),
    createCommand("code", "Code File", <Code size={15} />),
    createCommand("email", "Email", <Mail size={15} />),
    createCommand("spreadsheet", "Spreadsheet", <Table2 size={15} />),
    createCommand("website", "Website", <Globe size={15} />),
    createCommand("task", "Task", <CheckSquare size={15} />),
    {
      id: "new-page", label: "New Page", category: "create" as const, keys: shortcutKeys("newPage"),
      icon: <FilePlus2 size={15} />,
      action: () => { closeCommandBar(); usePagesUI.getState().openCreate({}); },
    },
    {
      id: "create-from-template", label: "New Page from Template", category: "create" as const,
      icon: <LayoutTemplate size={15} />,
      action: () => { closeCommandBar(); usePagesUI.getState().openCreate({ template: true }); },
    },
    {
      // NP-TX-01: the Templates gallery (list, use, edit, rename, delete).
      id: "templates", label: "Templates", category: "navigate" as const,
      icon: <LayoutTemplate size={15} />,
      action: () => { closeCommandBar(); usePagesUI.getState().openTemplates(true); },
    },
    {
      // Help → Keyboard shortcuts (NP-ED-07; also ⌘/ outside a block).
      id: "keyboard-shortcuts", label: "Keyboard Shortcuts", category: "navigate" as const, keys: shortcutKeys("shortcutSheet"),
      icon: <Settings size={15} />,
      action: () => { closeCommandBar(); openShortcutSheet(); },
    },
    {
      id: "open-home", label: "Home", category: "navigate" as const,
      icon: <HomeIcon size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().openTab("home", "Home", "home" as ContentType); },
    },
    {
      id: "open-inbox", label: "Open Inbox", category: "navigate" as const,
      icon: <InboxIcon size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().openTab("notifications", "Inbox", "notifications" as ContentType); },
    },
    {
      id: "open-trash", label: "Open Trash", category: "navigate" as const,
      icon: <Trash2 size={15} />,
      action: () => { closeCommandBar(); usePagesUI.getState().openTrash(true); },
    },
    // Wave 3A: import / export / print (components/import-export).
    ...(transferAvailable() && canTransfer ? [{
      id: "import", label: "Import… (Markdown, HTML, CSV, Notion)", category: "create" as const,
      icon: <Upload size={15} />,
      action: () => { closeCommandBar(); useTransferUI.getState().openImport({}); },
    }, {
      id: "export-workspace", label: "Export Workspace…", category: "sync" as const,
      icon: <Download size={15} />,
      action: () => { closeCommandBar(); useTransferUI.getState().openExport({ scope: "vault" }); },
    }] : []),
    ...(activeIsNote && activeTab ? [{
      id: "export-page", label: "Export Page…", category: "sync" as const,
      icon: <Download size={15} />,
      action: () => { closeCommandBar(); useTransferUI.getState().openExport({ scope: "page", page: { id: activeTab.noteId, title: activeTab.title, path: null } }); },
    }, {
      id: "print-page", label: "Print Page", category: "sync" as const,
      icon: <Printer size={15} />,
      action: () => { closeCommandBar(); printCurrentPage(); },
    }] : []),
    // NP-AI-03: agent actions on the open page (or its selection) — where this viewer has the agent
    // AND the page is open in a text editor (never on a sheet, canvas, code or virtual tab: no dead entries).
    ...(host && activeIsNote && activeTab && agentReady ? ([["summarize", "Summarize Page"], ["draft", "Draft with Agent…"], ["transform", "Transform with Agent…"]] as Array<[PageAgentKind, string]>).map(([kind, label]) => ({
      id: `agent-${kind}`, label, category: "agent" as const,
      icon: <Sparkles size={15} />,
      action: () => {
        closeCommandBar();
        // A selection in the page is the subject when there is one; else the whole page.
        window.setTimeout(() => {
          if (kind === "summarize" || !requestPageAgent(activeTab.noteId, activeTab.title, kind, "selection")) requestPageAgent(activeTab.noteId, activeTab.title, kind, "page");
        }, 60);
      },
    })) : []),
    ...(activeIsNote && activeTab ? [{
      id: "move-page", label: "Move Page To…", category: "navigate" as const,
      icon: <FolderInput size={15} />,
      action: () => { closeCommandBar(); usePagesUI.getState().openMove({ id: activeTab.noteId, path: null, title: activeTab.title }); },
    }] : []),
    ...(activeIsNote && activeTab ? [{
      id: "toggle-favorite", label: favoriteIds.includes(activeTab.noteId) ? "Remove This Page from Favorites" : "Add This Page to Favorites", category: "navigate" as const,
      icon: <Star size={15} />,
      action: () => { toggleFavorite({ id: activeTab.noteId, title: activeTab.title, type: activeTab.type }); closeCommandBar(); },
    }] : []),
    // Utility commands
    {
      id: "toggle-theme", label: "Toggle Theme", category: "navigate" as const, keys: shortcutKeys("toggleTheme"),
      icon: <SunMoon size={15} />,
      action: () => { toggleTheme(); closeCommandBar(); },
    },
    {
      id: "toggle-sidebar", label: "Toggle Sidebar", category: "navigate" as const, keys: shortcutKeys("toggleSidebar"),
      icon: <PanelLeft size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().toggleSidebar(); },
    },
    {
      id: "toggle-info-panel", label: "Toggle Info Panel", category: "navigate" as const, keys: shortcutKeys("toggleSidePanel"),
      icon: <PanelRight size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().toggleContextPanel(); },
    },
    {
      id: "nav-back", label: "Back", category: "navigate" as const, keys: shortcutKeys("navBack"),
      icon: <ChevronLeft size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().navBack(); },
    },
    {
      id: "nav-forward", label: "Forward", category: "navigate" as const, keys: shortcutKeys("navForward"),
      icon: <ChevronRight size={15} />,
      action: () => { closeCommandBar(); useUIStore.getState().navForward(); },
    },
    {
      id: "settings", label: "Settings", category: "navigate" as const, keys: shortcutKeys("settings"),
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
  ], [favoriteIds, toggleFavorite, createCommand, activeTab, activeIsNote, agentReady, agentChat, canTransfer, closeCommandBar, toggleContextPanel, setContextPanelTab, createNote, openTab, hostCmds, host, vaultClient, surface, transformNote]);

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
    // The rows on screen stay until the next answer arrives (typing on, a background
    // refetch): the list never blinks empty, and Enter acts on the row that is showing.
    const notes = query.trim() ? searchResults ?? [] : [];
    return notes.filter(note => filter !== "commands" && (filter === "all" || searchResultGroup(note) === filter)).map(note => {
      const label = note.path?.split("/").pop() || note.id;
      const marks = resultHighlights(note, label, debouncedQuery);
      return {
        id: `note-${note.id}`,
        noteId: note.id,
        label,
        labelRanges: marks.title,
        sublabel: note.path || "Saved note",
        edited: editedLabel(note.updatedAt),
        type: inferContentType(note),
        // ⌘↵ never crosses vaults: a result from another vault opens the ordinary way.
        sameVault: !(note as { _vault?: string })._vault,
        group: searchResultGroup(note),
        icon: typeof note.metadata?.icon === "string" ? note.metadata.icon : null,
        preview: marks.snippet,
        previewRanges: marks.snippetRanges,
        action: () => {
          rememberSearch(searchScope, debouncedQuery);
          const vault = (note as { _vault?: string })._vault;
          const type = inferContentType(note);
          closeCommandBar();
          if (!vault || !sharing?.setActiveVault) { openTab(note.id, label, type); return; }
          // A result from another vault: switch to it first, then open the page there.
          const before = useAgentChatStore.getState().scope;
          const stop = useAgentChatStore.subscribe((state) => {
            if (!state.scope || state.scope === before) return;
            stop();
            window.clearTimeout(timer);
            useUIStore.getState().openTab(note.id, label, type);
          });
          const timer = window.setTimeout(stop, 8000);
          sharing.setActiveVault(vault);
        },
      };
    });
  }, [searchResults, query, debouncedQuery, filter, openTab, closeCommandBar, searchScope, sharing]);
  // Empty query: recent pages first (synced across devices when the server keeps preferences).
  const recentItems = useMemo(() => (query.trim() || (filter !== "all" && filter !== "notes")) ? [] : recents.slice(0, 8).map(r => ({
    id: `recent-${r.id}`,
    noteId: r.id,
    label: r.title,
    sublabel: "Recently opened",
    edited: editedLabel(tree?.find((n) => n.id === r.id)?.updatedAt),
    type: r.type,
    sameVault: true,
    group: "notes" as const,
    icon: null as string | null,
    preview: "",
    labelRanges: [] as Range[],
    previewRanges: [] as Range[],
    action: () => { openTab(r.id, r.title, r.type); closeCommandBar(); },
  })), [recents, tree, query, filter, openTab, closeCommandBar]);
  // Recent searches (this device, this workspace): re-run with one keystroke.
  const recentQueryItems = (query.trim() || filter === "commands") ? [] : recentQueries.slice(0, 5).map((q, i) => ({
    id: `recent-search-${i}`, query: q,
    action: () => { setQuery(q); setSelectedId(null); inputRef.current?.focus({ preventScroll: true }); },
  }));
  const noteItems = [...recentItems, ...vaultItems.filter(item => item.group === "notes")];
  const messageItems = vaultItems.filter(item => item.group === "messages");
  const orderedNotes = [...noteItems, ...messageItems];
  const showAsk = !!query.trim() && agentChat && (filter === "all" || filter === "commands");
  const items = [...recentQueryItems, ...orderedNotes, ...filteredCommands, ...(showAsk ? [{ id: "ask-agent", action: () => askClaude() }] : [])];
  // Ask is never a default action: Enter while waiting or after zero matches
  // cannot accidentally submit the user's search as an agent prompt.
  const defaultId = orderedNotes[0]?.id ?? filteredCommands[0]?.id;
  const selectedIndex = items.findIndex(item => item.id === (selectedId ?? defaultId));
  const totalItems = items.length;
  useEffect(() => {
    if (commandBarOpen) document.getElementById(`prism-command-${selectedIndex}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [commandBarOpen, selectedIndex, totalItems]);
  // A mouse press on a row acts on THAT item when the button comes up, wherever the row is by
  // then. Results that land between down and up push rows down the list: the button then comes
  // up over another row and the browser produces no click (it needs both on one element), so
  // the press used to be lost. The pressed item is remembered by id; it runs if the pointer
  // comes up on its row, or anywhere in the dialog once its row has moved (or left the screen)
  // since the press — rows are also pushed by what loads ABOVE the list. A deliberate drag off
  // the row while nothing moved cancels, and the row the pointer ended on is never opened.
  // Touch and keyboard keep the ordinary click.
  // "Moved" is judged in the LIST's own coordinates: the row's offset inside the scroller's content
  // (scrolling the list — a wheel, or `scrollIntoView` when the pointer selects a clipped row — is not
  // the row moving) plus where the scroller itself sits (the filter bar appearing above it is).
  const pressRef = useRef<{ id: string; at: { offset: number; list: number } | null } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const rowOf = (id: string) => document.querySelector<HTMLElement>(`#prism-command-results [data-command-item="${CSS.escape(id)}"]`);
  const placeOf = (id: string): { offset: number; list: number } | null => {
    const row = rowOf(id);
    const list = document.getElementById("prism-command-results");
    if (!row || !list) return null;
    const top = list.getBoundingClientRect().top;
    return { offset: row.getBoundingClientRect().top - top + list.scrollTop, list: top };
  };
  const pressRow = (id: string, e: React.PointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) { pressRef.current = null; return; }
    pressRef.current = { id, at: placeOf(id) };
  };
  /** The row's click: everything except the mouse press handled above (touch, assistive tech, script). */
  const clickRow = (id: string) => {
    if (pressRef.current) { pressRef.current = null; return; }
    itemsRef.current.find((item) => item.id === id)?.action();
  };
  useEffect(() => {
    if (!commandBarOpen) { pressRef.current = null; return; }
    const release = (e: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      // The click that may follow this release belongs to the press: let `clickRow` drop it, then forget.
      window.setTimeout(() => { if (pressRef.current === press) pressRef.current = null; }, 0);
      if (e.type === "pointercancel" || e.button !== 0) return;
      const item = itemsRef.current.find((candidate) => candidate.id === press.id);
      if (!item) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !dialogRef.current?.contains(target)) return;
      const row = rowOf(press.id);
      const onRow = !!row && row.contains(target);
      const now = placeOf(press.id);
      const moved = !now || !press.at || Math.abs(now.offset - press.at.offset) > 1 || Math.abs(now.list - press.at.list) > 1;
      if (onRow || moved) item.action();
    };
    // A press whose release never reached us (the button came up outside the window, a context menu
    // took it) must not wait for the next release: any new press that is not on a row, a context
    // menu, and the window going away all forget it. (Window capture runs before the row's own
    // `pointerdown`, which then records the new press.)
    const forget = () => { pressRef.current = null; };
    const pressElsewhere = (e: PointerEvent) => { if (!(e.target instanceof Element && e.target.closest("[data-command-item]"))) forget(); };
    const hidden = () => { if (document.visibilityState !== "visible") forget(); };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("pointerdown", pressElsewhere, true);
    window.addEventListener("contextmenu", forget, true);
    window.addEventListener("blur", forget);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("pointerdown", pressElsewhere, true);
      window.removeEventListener("contextmenu", forget, true);
      window.removeEventListener("blur", forget);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [commandBarOpen]);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCommandBar(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.max(0, Math.min(selectedIndex + 1, totalItems - 1)) : Math.max(selectedIndex - 1, 0);
      setSelectedId(items[next]?.id ?? null);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // The keyboard decided: a mouse press still waiting for its release is dropped (it would run a second item).
      pressRef.current = null;
      // ⌘↵ / Ctrl+↵ on a page: open it in a new tab and stay on this one (NP-SR-01).
      const note = (e.metaKey || e.ctrlKey) ? orderedNotes.find((item) => item.id === items[selectedIndex]?.id) : undefined;
      if (note?.sameVault) { rememberSearch(searchScope, debouncedQuery); closeCommandBar(); openInNewTab(note.noteId, note.label, note.type); return; }
      items[selectedIndex]?.action();
    }
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
  const filterCount = activeFilterCount(searchFilters, searchIdentity);
  const filterBar = filter !== "commands" && <SearchFilterBar value={searchFilters} vaults={searchVaults} identity={searchIdentity} onChange={(next) => { setSearchFilters(next); setSelectedId(null); }} />;
  const status = <div className="prism-search-status" role="status">
    <span>{searchFilters.vault ? searchVaults?.find((v) => v.id === searchFilters.vault)?.label ?? "Another vault" : "Current workspace"}</span><span>{!query.trim() ? "Search notes or choose an action" : searchingNow ? "Searching…" : searchFailed ? "Search unavailable" : `${vaultItems.length} results shown · ${searchModeLabel(searchMode)}${filterCount ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : ""}`}</span>
  </div>;
  const renderNotes = (notes: typeof vaultItems, label: string) => notes.length > 0 && <div role="group" aria-label={label}>
    <div className="prism-search-group">{label}</div>
    {notes.map(item => { const index = items.findIndex(candidate => candidate.id === item.id); return <CmdRow key={item.id} id={`prism-command-${index}`} itemId={item.id} selected={selectedIndex === index} onPress={pressRow} onClick={clickRow} onHover={() => setSelectedId(item.id)}
      icon={pageIconOf(item.icon) ? <PageIconView value={item.icon} fallback={<FileText size={18} />} /> : item.group === "messages" ? <MessageSquare size={18} /> : <PageIcon noteId={item.noteId} fallback={<FileText size={18} />} />}
      label={item.label} labelRanges={item.labelRanges} sublabel={item.edited ? `${item.sublabel} · ${item.edited}` : item.sublabel} preview={item.preview} previewRanges={item.previewRanges} trailing={<span className="prism-search-open">Open <ArrowRight size={13} /></span>} />; })}
  </div>;
  const body = <>
    {recentQueryItems.length > 0 && <div role="group" aria-label="Recent searches"><div className="prism-search-group">Recent searches</div>{recentQueryItems.map(item => {
      const index = items.findIndex(candidate => candidate.id === item.id);
      return <CmdRow key={item.id} id={`prism-command-${index}`} itemId={item.id} selected={selectedIndex === index} onPress={pressRow} onClick={clickRow} onHover={() => setSelectedId(item.id)} icon={<Search size={16} />} label={item.query} />;
    })}</div>}
    {recentItems.length > 0 ? renderNotes(noteItems, "Recent pages") : renderNotes(noteItems, "Notes")}{renderNotes(messageItems, "Messages")}
    {filteredCommands.length > 0 && <div role="group" aria-label="Commands"><div className="prism-search-group">Commands</div>{filteredCommands.map(cmd => {
      const index = items.findIndex(item => item.id === cmd.id);
      return <CmdRow key={cmd.id} id={`prism-command-${index}`} itemId={cmd.id} selected={selectedIndex === index} onPress={pressRow} onClick={clickRow} onHover={() => setSelectedId(cmd.id)} icon={cmd.icon} label={cmd.label} keys={cmd.keys} />;
    })}</div>}
    {showAsk && <CmdRow key="ask-agent" id={`prism-command-${items.length - 1}`} itemId="ask-agent" selected={selectedIndex === items.length - 1} onPress={pressRow} onClick={clickRow} onHover={() => setSelectedId("ask-agent")} icon={<Bot size={18} />} label={`Ask your agent: "${query}"`} accent trailing={<ArrowRight size={13} />} />}
  </>;
  const selectedNote = orderedNotes.find(item => item.id === (selectedId ?? defaultId));
  // Selected page actions: star it without opening it (NP-SB-04), hand it to the agent.
  const selectedFav = !!selectedNote && favoriteIds.includes(selectedNote.noteId);
  const contextActions = selectedNote && (agentChat || selectedNote.sameVault) && <div aria-label="Selected note actions" className="flex min-w-0 items-center justify-between gap-2 border-t px-3" style={{ borderColor: "var(--glass-border)" }}>
    <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--text-secondary)" }}>{selectedNote.label}</span>
    {selectedNote.sameVault && <button type="button" className="prism-search-star focus-ring" aria-pressed={selectedFav}
      aria-label={selectedFav ? `Remove ${selectedNote.label} from Favorites` : `Add ${selectedNote.label} to Favorites`}
      onClick={() => toggleFavorite({ id: selectedNote.noteId, title: selectedNote.label, type: selectedNote.type })}>
      <Star size={14} aria-hidden fill={selectedFav ? "var(--color-accent)" : "none"} color={selectedFav ? "var(--color-accent)" : "currentColor"} />
      <span>{selectedFav ? "Starred" : "Star"}</span>
    </button>}
    {agentChat && <AddSavedNoteContextButton noteId={selectedNote.noteId} label={selectedNote.label} onAdded={closeCommandBar} />}
  </div>;
  const feedback = <>
    {query.trim() && searchFailed && <div role="alert" className="prism-search-feedback">Couldn't search this workspace. <button className="focus-ring" onClick={() => void retrySearch()}>Try again</button></div>}
    {query.trim() && !searchingNow && !searchFailed && !vaultItems.length && filter !== "commands" && <p className="prism-search-feedback">{filter === "messages" ? "No matching messages in these results." : "No matching notes."} <span>Try a name, phrase, or related idea.</span></p>}
    {filter === "commands" && !filteredCommands.length && <p className="prism-search-feedback">No matching commands.</p>}
  </>;
  // Phone (NP-SR-08): a full-screen Search surface — field at the top with the
  // keyboard up at once, recent searches and pages below, 44 px rows. Sized to
  // the visual viewport so the list ends above the keyboard.
  if (isMobile) {
    return (
      <dialog ref={dialogRef} aria-label="Search workspace" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); closeCommandBar(); }}
        className="prism-search-fullscreen fixed inset-0 m-0 max-h-none w-full max-w-none border-0 p-0 text-[var(--text-primary)]"
        style={{ zIndex: "var(--z-modal)" as unknown as number, height: viewportHeight ? `${viewportHeight}px` : "100dvh" }}
      >
        <div className="prism-search-sheet prism-search-sheet-full flex h-full flex-col" data-testid="phone-search">
          {inputRow}{filters}{filterBar}{status}{feedback}<div id="prism-command-results" role="listbox" aria-label="Notes and commands" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6 }}>{body}</div>
          {contextActions}
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
        {inputRow}{filters}{filterBar}{status}{feedback}
        <div id="prism-command-results" role="listbox" aria-label="Notes and commands" style={{ maxHeight: "min(440px, 56vh)", overflowY: "auto", padding: 6 }}>{body}</div>

        {contextActions}
        {/* Footer keyboard hints */}
        <div
          className="flex items-center gap-4"
          style={{ padding: "8px 14px", borderTop: "1px solid var(--glass-border)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
        >
          <span className="flex items-center gap-1"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd>↵</kbd> open</span>
          <span className="flex items-center gap-1"><kbd>{hint("mod", "enter")}</kbd> new tab</span>
          <span className="flex items-center gap-1"><kbd>esc</kbd> close</span>
        </div>
      </div>
    </dialog>
  );
}

/** A single command-palette row: quiet at rest, surface-fill when selected. */
function CmdRow({
  id,
  itemId,
  selected,
  onPress,
  onClick,
  onHover,
  icon,
  label,
  labelRanges,
  sublabel,
  preview,
  previewRanges,
  accent,
  trailing,
  keys,
}: {
  id: string;
  /** The item's identity (stable while the list changes; `id` is its position). */
  itemId: string;
  selected: boolean;
  onPress: (itemId: string, e: React.PointerEvent) => void;
  onClick: (itemId: string) => void;
  onHover: () => void;
  icon: React.ReactNode;
  label: string;
  labelRanges?: Range[];
  sublabel?: string;
  preview?: string;
  previewRanges?: Range[];
  accent?: boolean;
  trailing?: React.ReactNode;
  /** A keyboard shortcut for this row: a visible hint (kept out of the row's name) + aria-keyshortcuts. */
  keys?: string[];
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={selected}
      aria-keyshortcuts={keys ? ariaKeys(...keys) : undefined}
      data-command-item={itemId}
      tabIndex={-1}
      onPointerDown={(e) => onPress(itemId, e)}
      onClick={() => onClick(itemId)}
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
        <div className="prism-search-result-title"><Highlighted text={label} ranges={labelRanges ?? []} /></div>
        {preview && <div className="mt-1 line-clamp-2 break-words text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}><Highlighted text={preview} ranges={previewRanges ?? []} /></div>}
        {sublabel && (
          <div className="truncate" style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{sublabel}</div>
        )}
      </div>
      {trailing && <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{trailing}</span>}
      {keys && <kbd aria-hidden="true" className="prism-command-shortcut" style={{ marginLeft: "auto" }}>{hint(...keys)}</kbd>}
    </button>
  );
}
