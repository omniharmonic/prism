import { NavigationPreferences, useNavigationPreferences, TOOL_NAMES, type NavigationTool } from "./NavigationPreferences";
import { useNoteShortcuts } from "./NoteShortcuts";
import { useCallback, useRef, useState } from "react";
import { Search, Calendar, MessageSquare, PenSquare, Bot, RefreshCw, ChevronRight, FileText, Star, X, MapPin, FolderPlus, ChevronsDownUp, Sparkles, Users, Plus, Settings2, Trash2, LayoutTemplate, ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PrismMark } from "../brand/PrismMark";
import { Input } from "../ui/Input";
import { ProjectTree } from "./ProjectTree";
import { SearchPanel } from "./SearchPanel";
import { NewContentMenu } from "./NewContentMenu";
import { VaultSwitcher } from "./VaultSwitcher";
import { useDebounce } from "use-debounce";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { useCreateNote } from "../../app/hooks/useParachute";
import { ComposeMessage } from "../comms/ComposeMessage";
import type { ContentType } from "../../lib/types";
import { useAgentAvailable } from "../../data/AgentClientContext";
import { openAgentChat } from "../../lib/agent/chatStore";
import { usePagesUI } from "../../lib/pages/store";
import { PageIcon } from "../../lib/pages/icons";
import { Home as HomeIcon, Inbox as InboxIcon } from "lucide-react";
import { InboxBadge, openInbox } from "../inbox/InboxNavButton";
import { SyncStateBadge } from "../layout/SyncStateBadge";
import { useQuickCreatePage } from "../../lib/pages/quickCreate";
import { useUnreadCount } from "../../lib/notifications/hooks";
import { SharedWithMe, useViewerIsGuest } from "../sharing/SharedWithMe";

export function Navigation() {
  const preferences = useNavigationPreferences();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery] = useDebounce(searchQuery, 200);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const openNewMenu = useCallback(() => setShowNewMenu(true), []);
  const quickCreate = useQuickCreatePage(openNewMenu);
  const [showCompose, setShowCompose] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const createNote = useCreateNote();
  const folderPending = useRef(false);
  const [folderError, setFolderError] = useState("");
  const collapseNav = useUIStore((s) => s.collapseNav);
  const sidebarLabel = useSettingsStore((s) => s.sidebarLabel);
  const shortcuts = useNoteShortcuts();
  const { favorites, recents, toggleFavorite } = shortcuts;
  // Section open state: synced per user × vault when the server keeps preferences.
  const sectionProps = (id: string, defaultOpen: boolean) => shortcuts.synced && shortcuts.collapsed
    ? { open: !shortcuts.collapsed.includes(id), onToggle: (open: boolean) => shortcuts.setCollapsed(id, !open) }
    : { defaultOpen };
  const openTab = useUIStore((s) => s.openTab);
  const activeTabId = useUIStore((s) => s.activeTabId);
  const openTabs = useUIStore((s) => s.openTabs);
  // Server agent sessions (WP3.2): owner-only, and only on shells with an AgentClient.
  const agentChat = useAgentAvailable();
  // Notifications inbox (wave 2A): shown only when this server has the feature.
  const inbox = useUnreadCount();
  // NP-SB-09: a guest (no workspace role) sees what was shared with them and none
  // of the workspace's own sections.
  const guest = useViewerIsGuest();

  const handleOpenMessages = () => {
    openTab("vault-messages", "Messages", "vault-messages" as ContentType);
  };

  const handleOpenCalendar = () => {
    openTab("calendar-dashboard", "Calendar", "calendar-dashboard" as ContentType);
  };

  const handleOpenAgentActivity = () => {
    openTab("agent-activity", "Agent", "agent-activity" as ContentType);
  };

  const handleOpenNetwork = () => {
    openTab("network", "Workspace settings", "network" as ContentType);
  };

  const handleOpenMap = () => {
    openTab("map", "Map", "map" as ContentType);
  };

  // "New folder" for a path-based vault. Parachute has no empty-folder entity —
  // a folder exists only because notes carry that path prefix. So we materialize
  // the folder by seeding a first note (`<folder>/Untitled`) inside it, then open
  // it. (useCreateNote already invalidates the vault query, refreshing the tree.)
  const handleCreateFolder = async () => {
    if (folderPending.current) return;
    const raw = newFolderName.trim();
    setFolderError("");
    if (!raw) return;
    // Sanitize: no leading/trailing slashes, drop "." / ".." traversal segments.
    const folder = raw
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s && s !== "." && s !== "..")
      .join("/");
    if (!folder) return;
    folderPending.current = true;
    try {
      const note = await createNote.mutateAsync({ path: `${folder}/Untitled`, content: "# Untitled" });
      setNewFolderOpen(false);
      setNewFolderName("");
      openTab(note.id, "Untitled", "document");
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : "Could not create the folder. Try again.");
    } finally {
      folderPending.current = false;
    }
  };

  const activeNoteId = openTabs.find(tab => tab.id === activeTabId)?.noteId;
  const tools: Record<NavigationTool, { icon: React.ReactNode; onClick: () => void; active: boolean }> = {
    calendar: { icon: <Calendar size={15} />, onClick: handleOpenCalendar, active: activeNoteId === "calendar-dashboard" },
    people: { icon: <Users size={15} />, onClick: () => openTab("people", "People", "people" as ContentType), active: activeNoteId === "people" },
    automations: { icon: <Bot size={15} />, onClick: handleOpenAgentActivity, active: activeNoteId === "agent-activity" },
    map: { icon: <MapPin size={15} />, onClick: handleOpenMap, active: activeNoteId === "map" },
  };
  const toolRows = (placement: "pinned" | "tools") => preferences.value.order.filter(id => preferences.value.placement[id] === placement).map(id => <NavItem key={id} label={TOOL_NAMES[id]} {...tools[id]} />);

  return (
    <div
      data-density={preferences.value.density}
      className="workspace-navigation h-full flex flex-col"
      style={{
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--glass-border)",
      }}
    >
      {/* Workspace header — brand mark + name (Notion/Anytype space header) */}
      <div
        className="flex items-center gap-2.5 flex-shrink-0"
        style={{ height: 64, padding: "0 14px" }}
      >
        <PrismMark decorative className="flex-shrink-0" />
        <span
          style={{
            fontSize: "var(--text-md)",
            fontWeight: 650,
            letterSpacing: "-0.015em",
            color: "var(--text-primary)",
          }}
        >
          Prism
        </span>
      </div>

      <div className="workspace-vault-heading"><VaultSwitcher onManage={handleOpenNetwork} placement="below" /></div>

      {/* Search */}
      <div style={{ padding: "0 10px 8px" }}>
        <Input
          icon={<Search size={14} />}
          placeholder="Search... (&#8984;K)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Search results overlay */}
      {debouncedQuery.length > 0 ? (
        <SearchPanel query={debouncedQuery} onClose={() => setSearchQuery("")} />
      ) : (
        <div className="flex-1 overflow-auto" style={{ padding: "0 8px" }}>
          {/* Quick-access items */}
          <nav aria-label="Workspace destinations" style={{ display: "flex", flexDirection: "column", gap: 1, paddingBottom: 4 }}>
            <NavItem icon={<HomeIcon size={15} />} label="Home" active={activeNoteId === "home"} onClick={() => openTab("home", "Home", "home" as ContentType)} />
            {inbox.available && (
              <NavItem icon={<InboxIcon size={15} />} label="Inbox" active={activeNoteId === "notifications"} onClick={openInbox}
                ariaLabel={inbox.count > 0 ? `Inbox, ${inbox.count} unread` : "Inbox"}
                trailing={<span className="flex items-center" style={{ paddingRight: 8 }}><InboxBadge /></span>} />
            )}
            {!guest && <NavItem
              icon={<MessageSquare size={15} />}
              label="Messages"
              active={openTabs.find((t) => t.id === activeTabId)?.noteId === "vault-messages"}
              onClick={handleOpenMessages}
              trailing={
                <RowAction
                  title="Compose message"
                  onClick={() => setShowCompose(true)}
                  icon={<PenSquare size={13} />}
                />
              }
            />}
            {!guest && agentChat && <NavItem icon={<Sparkles size={15} />} active={openTabs.find((t) => t.id === activeTabId)?.noteId === "agent-chat"} label="Agent conversations" onClick={() => openAgentChat()} />}
            {!guest && toolRows("pinned")}
          </nav>

          {shortcuts.recoverable && <div className="mx-3 my-3 rounded-lg border border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)]">
            <p>Older shortcuts are available. Recover only notes you can open in this workspace.</p>
            <button className="focus-ring mt-2 min-h-9 text-[var(--text-accent)]" disabled={shortcuts.recovering} onClick={shortcuts.recover}>{shortcuts.recovering ? "Checking access…" : "Recover older shortcuts"}</button>
            <button className="focus-ring ml-3 min-h-9" onClick={shortcuts.dismissRecovery}>Dismiss</button>
          </div>}
          {shortcuts.recoveryMessage && <p role="status" className="mx-3 my-2 text-xs text-[var(--text-secondary)]">{shortcuts.recoveryMessage}</p>}
          {shortcuts.unavailable && <div role="status" className="mx-3 my-2 text-xs text-[var(--text-secondary)]">Some shortcuts are unavailable. <button className="focus-ring min-h-9 text-[var(--text-accent)]" onClick={shortcuts.retry}>Retry shortcuts</button></div>}
          {shortcuts.storageUnavailable && <p role="status" className="mx-3 my-2 text-xs text-[var(--text-secondary)]">Shortcuts work here, but couldn’t be saved on this device.</p>}
          {/* Favorites — always present, so there is a visible place to pin pages. */}
          <NavSection label="Favorites" {...sectionProps("favorites", true)}>
            {favorites.length === 0 && (
              <p className="workspace-nav-empty" style={{ padding: "2px 10px 6px 28px", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                Star a page to pin it here.
              </p>
            )}
            {favorites.map((f) => (
              <NavItem
                key={f.id}
                icon={<PageIcon noteId={f.id} fallback={<Star size={14} fill="var(--color-accent)" color="var(--color-accent)" />} />}
                label={f.title}
                active={openTabs.find((t) => t.id === activeTabId)?.noteId === f.id}
                onClick={() => openTab(f.id, f.title, f.type)}
                trailing={<RowAction title="Remove from Favorites" onClick={() => toggleFavorite(f)} icon={<X size={12} />} />}
              />
            ))}
          </NavSection>

          {/* Recently opened notes */}
          {recents.length > 0 && (
            <NavSection label="Recent" {...sectionProps("recent", shortcuts.synced)}>
              {recents.map((r) => (
                <NavItem
                  key={r.id}
                  icon={<PageIcon noteId={r.id} fallback={<FileText size={15} />} />}
                  label={r.title}
                  active={openTabs.find((t) => t.id === activeTabId)?.noteId === r.id}
                  onClick={() => openTab(r.id, r.title, r.type)}
                />
              ))}
            </NavSection>
          )}

          <SharedWithMe guest={guest} activeId={activeNoteId} onOpen={(item) => openTab(item.id, item.title, "document")} />

          {/* Projects / vault notes */}
          {!guest && <><NavSection label={sidebarLabel === "Projects" ? "Pages" : sidebarLabel} {...sectionProps("pages", true)} action={<div className="flex items-center"><NavActionButton title="New page from template" icon={<LayoutTemplate size={14} />} onClick={() => usePagesUI.getState().openCreate({ template: true })} /><NavActionButton title="New folder" icon={<FolderPlus size={14} />} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }} /><NavActionButton title="Collapse all" icon={<ChevronsDownUp size={14} />} onClick={collapseNav} /><RefreshNavButton /></div>}>
            <ProjectTree />
          </NavSection>
          <NavSection label="Tools" action={<NavActionButton title="Customize sidebar" icon={<Settings2 size={14} />} onClick={() => setPreferencesOpen(true)} />}>
            {toolRows("tools")}
            <button type="button" className="focus-ring min-h-9 w-full rounded-md px-3 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--glass-hover)]" onClick={() => setPreferencesOpen(true)}>Customize sidebar…</button>
          </NavSection></>}
        </div>
      )}

      {/* Primary creation and workspace administration stay within reach. */}
      <div
        style={{
          padding: 8,
          position: "relative",
          borderTop: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* New-folder inline input (path-based vault: an empty folder can't
            persist, so confirming seeds an Untitled note inside it). */}
        {newFolderOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateFolder();
            }}
            className="flex items-center gap-1.5"
          >
            <FolderPlus size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            <input
              autoFocus
              disabled={createNote.isPending}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}

              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNewFolderOpen(false);
                  setNewFolderName("");
                }
              }}
              aria-label="Folder name"
              placeholder="Folder name"
              className="flex-1 h-7 px-2 text-sm rounded outline-none"
              style={{
                background: "var(--glass)",
                border: "1px solid var(--color-accent)",
                color: "var(--text-primary)",
              }}
            />
            <button type="submit" className="focus-ring text-xs px-2 py-2" disabled={createNote.isPending || !newFolderName.trim()}>Add</button>
            <button disabled={createNote.isPending} type="button" aria-label="Cancel folder" className="focus-ring p-2" onClick={() => setNewFolderOpen(false)}><X size={14} /></button>
          </form>
        )}

        {newFolderOpen && folderError && <p role="alert" className="text-xs text-[var(--color-danger)]">{folderError}</p>}
        {/* NP-SB-13: one action → an "Untitled" page with its title focused. The
            caret keeps the type/location chooser one click away. */}
        {!guest && <div className="workspace-new-page-row">
          <button type="button" className="workspace-new-page focus-ring" aria-label="New page" aria-busy={quickCreate.pending || undefined}
            onClick={event => { event.currentTarget.focus(); quickCreate.create(); }}>
            <Plus size={18} /><span>New page</span>
          </button>
          <button type="button" className="workspace-new-page-more focus-ring" aria-label="Choose page type" title="Choose page type and location"
            onClick={event => { event.currentTarget.focus(); setShowNewMenu(true); }}>
            <ChevronDown size={16} aria-hidden />
          </button>
        </div>}
        {!guest && <NavItem icon={<Trash2 size={16} />} label="Trash" active={false} onClick={() => usePagesUI.getState().openTrash(true)} />}
        {/* NP-SB-15: the one truthful sync state, in the sidebar footer. */}
        <SyncStateBadge variant="footer" />
        <NavItem icon={<Settings2 size={16} />} label="Workspace settings" active={openTabs.find(t => t.id === activeTabId)?.noteId === "network"} onClick={handleOpenNetwork} />
        {showNewMenu && <NewContentMenu onClose={() => setShowNewMenu(false)} />}

      </div>

      {preferencesOpen && <NavigationPreferences preferences={preferences} onClose={() => setPreferencesOpen(false)} />}
      {/* Compose message modal */}
      {showCompose && <ComposeMessage onClose={() => setShowCompose(false)} />}
    </div>
  );
}

/** Primary action and trailing actions are sibling buttons for keyboard access. */
function NavItem({ icon, label, onClick, trailing, active = false, ariaLabel }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  trailing?: React.ReactNode;
  active?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div data-active={active} className="workspace-nav-row group flex items-center"
      style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)", fontSize: "var(--text-base)", paddingRight: trailing ? 6 : 0 }}>
      <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} aria-label={ariaLabel}
        className="interactive focus-ring flex flex-1 min-w-0 items-center gap-2.5 text-left"
        style={{ minHeight: "var(--workspace-control-height)", padding: "0 10px" }}>
        <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, color: "var(--text-muted)" }}>{icon}</span>
        <span className="flex-1 truncate">{label}</span>
      </button>
      {trailing}
    </div>
  );
}

/** A compact action beside the page-tree heading: quiet at rest,
 *  gentle tint + brighter icon on hover. */
function NavActionButton({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={event => { event.currentTarget.focus(); onClick(); }}
      title={title}
      aria-label={title}
      className="focus-ring flex items-center justify-center transition-colors flex-shrink-0"
      style={{
        width: 30,
        height: 30,
        borderRadius: "var(--radius-md)",
        color: "var(--text-muted)",
        background: "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--glass-hover)";
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {icon}
    </button>
  );
}

/** Small hover-revealed action button on the right edge of a nav row. */
function RowAction({ icon, title, onClick }: { icon: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={title}
      className="workspace-row-action interactive flex items-center justify-center transition-opacity"
      style={{ width: 28, height: 32, color: "var(--text-muted)" }}
    >
      {icon}
    </button>
  );
}

function NavSection({
  label,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  action,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** Controlled open state (synced sidebar preferences); uncontrolled otherwise. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** Optional control rendered on the right of the section header (e.g. refresh). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => (onToggle ? onToggle(next) : setLocalOpen(next));

  return (
    <section aria-label={label} style={{ marginTop: 18 }}>
      {/* Header row: the toggle takes the full width; the action sits beside it
          (kept outside the toggle <button> so it's not a nested button). */}
      <div className="flex items-center group" style={{ paddingRight: 4 }}>
        <button
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="interactive flex-1 flex items-center gap-1"
          style={{
            minHeight: 32,
            padding: "0 6px",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            textTransform: "none",
            letterSpacing: "0.01em",
            color: "var(--text-muted)",
          }}
        >
          <ChevronRight
            size={12}
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--transition-fast)" }}
          />
          {label}
        </button>
        <span className="workspace-section-actions">{action}</span>
      </div>
      {open && <div style={{ marginTop: 1 }}>{children}</div>}
    </section>
  );
}

/**
 * Refreshes the vault tree on demand. Notes created out-of-band (e.g. by the
 * agent writing straight to Parachute) don't push an invalidation into the
 * client, so the sidebar can lag until reload — this refetches it immediately.
 * Refetches all *active* vault queries so the open note/graph update too, and
 * spins the icon until the refetch settles.
 */
function RefreshNavButton() {
  const queryClient = useQueryClient();
  const [spinning, setSpinning] = useState(false);

  const refresh = async () => {
    if (spinning) return;
    setSpinning(true);
    try {
      await queryClient.refetchQueries({ queryKey: ["vault"], type: "active" });
    } finally {
      setSpinning(false);
    }
  };

  return (
    <button
      onClick={refresh}
      title="Refresh vault"
      className="interactive flex items-center justify-center"
      style={{ width: 28, height: 32, color: "var(--text-muted)" }}
    >
      <RefreshCw size={12} className={spinning ? "animate-spin" : ""} />
    </button>
  );
}
