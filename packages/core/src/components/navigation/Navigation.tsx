import { useEffect, useState } from "react";
import { Search, Calendar, Plus, MessageSquare, PenSquare, Bot, RefreshCw, ChevronRight, FileText, Star, X, Radio } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "../ui/Input";
import { ProjectTree } from "./ProjectTree";
import { SearchPanel } from "./SearchPanel";
import { NewContentMenu } from "./NewContentMenu";
import { VaultSwitcher } from "./VaultSwitcher";
import { useDebounce } from "use-debounce";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { ComposeMessage } from "../comms/ComposeMessage";
import type { ContentType } from "../../lib/types";

/** Virtual tab ids that aren't real notes (so they're excluded from Recent). */
const VIRTUAL_TABS = new Set(["messages-dashboard", "calendar-dashboard", "agent-activity", "vault-messages", "network"]);

export function Navigation() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery] = useDebounce(searchQuery, 200);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const sidebarLabel = useSettingsStore((s) => s.sidebarLabel);
  const recents = useSettingsStore((s) => s.recents);
  const pushRecent = useSettingsStore((s) => s.pushRecent);
  const favorites = useSettingsStore((s) => s.favorites);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const openTab = useUIStore((s) => s.openTab);
  const activeTabId = useUIStore((s) => s.activeTabId);
  const openTabs = useUIStore((s) => s.openTabs);

  // Record the active note into Recent (skipping virtual dashboards/non-notes).
  useEffect(() => {
    if (!activeTabId) return;
    const tab = openTabs.find((t) => t.id === activeTabId);
    if (!tab || tab.noteId.includes(":") || VIRTUAL_TABS.has(tab.noteId)) return;
    pushRecent({ id: tab.noteId, title: tab.title, type: tab.type });
  }, [activeTabId, openTabs, pushRecent]);

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
    openTab("network", "Network", "network" as ContentType);
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--glass-border)",
      }}
    >
      {/* Workspace header — brand mark + name (Notion/Anytype space header) */}
      <div
        className="flex items-center gap-2.5 flex-shrink-0"
        style={{ height: 52, padding: "0 14px" }}
      >
        <img
          src="/prism-logo-nav.png"
          alt="Prism"
          width={26}
          height={26}
          className="flex-shrink-0"
          style={{
            borderRadius: 7,
            objectFit: "cover",
            boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
          }}
        />
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
          <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingBottom: 4 }}>
            <NavItem
              icon={<MessageSquare size={15} />}
              label="Messages"
              onClick={handleOpenMessages}
              trailing={
                <RowAction
                  title="Compose message"
                  onClick={() => setShowCompose(true)}
                  icon={<PenSquare size={13} />}
                />
              }
            />
            <NavItem icon={<Calendar size={15} />} label="Calendar" onClick={handleOpenCalendar} />
            <NavItem icon={<Bot size={15} />} label="Agent" onClick={handleOpenAgentActivity} />
            <NavItem icon={<Radio size={15} />} label="Network" onClick={handleOpenNetwork} />
          </div>

          {/* Favorites (pinned notes) */}
          {favorites.length > 0 && (
            <NavSection label="Favorites" defaultOpen>
              {favorites.map((f) => (
                <NavItem
                  key={f.id}
                  icon={<Star size={14} fill="var(--color-accent)" color="var(--color-accent)" />}
                  label={f.title}
                  onClick={() => openTab(f.id, f.title, f.type)}
                  trailing={<RowAction title="Remove from Favorites" onClick={() => toggleFavorite(f)} icon={<X size={12} />} />}
                />
              ))}
            </NavSection>
          )}

          {/* Recently opened notes */}
          {recents.length > 0 && (
            <NavSection label="Recent" defaultOpen>
              {recents.map((r) => (
                <NavItem
                  key={r.id}
                  icon={<FileText size={15} />}
                  label={r.title}
                  onClick={() => openTab(r.id, r.title, r.type)}
                />
              ))}
            </NavSection>
          )}

          {/* Projects / vault notes */}
          <NavSection label={sidebarLabel} defaultOpen action={<RefreshNavButton />}>
            <ProjectTree />
          </NavSection>
        </div>
      )}

      {/* Footer: vault switcher (Obsidian-style) + compact New action */}
      <div
        style={{
          padding: 10,
          position: "relative",
          borderTop: "1px solid var(--glass-border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <VaultSwitcher onManage={handleOpenNetwork} />
        <button
          onClick={() => setShowNewMenu(!showNewMenu)}
          title="New"
          aria-label="New"
          className="focus-ring flex items-center justify-center transition-colors flex-shrink-0"
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-md)",
            color: "var(--color-accent)",
            background: "var(--color-accent-dim)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.filter = "")}
        >
          <Plus size={16} />
        </button>
        {showNewMenu && <NewContentMenu onClose={() => setShowNewMenu(false)} />}
      </div>

      {/* Compose message modal */}
      {showCompose && <ComposeMessage onClose={() => setShowCompose(false)} />}
    </div>
  );
}

/** A primary sidebar row: quiet at rest, gentle tint on hover (Notion-style).
 *  Rendered as a div so optional trailing actions can be real buttons without
 *  nesting <button> elements. */
function NavItem({
  icon,
  label,
  onClick,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="interactive focus-ring group flex items-center gap-2.5"
      style={{ height: 32, padding: "0 8px", color: "var(--text-secondary)", fontSize: "var(--text-base)" }}
    >
      <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, color: "var(--text-muted)" }}>
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {trailing}
    </div>
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
      className="interactive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      style={{ width: 22, height: 22, color: "var(--text-muted)" }}
    >
      {icon}
    </button>
  );
}

function NavSection({
  label,
  defaultOpen = false,
  action,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** Optional control rendered on the right of the section header (e.g. refresh). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginTop: 6 }}>
      {/* Header row: the toggle takes the full width; the action sits beside it
          (kept outside the toggle <button> so it's not a nested button). */}
      <div className="flex items-center group" style={{ paddingRight: 4 }}>
        <button
          onClick={() => setOpen(!open)}
          className="interactive flex-1 flex items-center gap-1"
          style={{
            height: 26,
            padding: "0 6px",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-muted)",
          }}
        >
          <ChevronRight
            size={12}
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--transition-fast)" }}
          />
          {label}
        </button>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">{action}</span>
      </div>
      {open && <div style={{ marginTop: 1 }}>{children}</div>}
    </div>
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
      style={{ width: 22, height: 22, color: "var(--text-muted)" }}
    >
      <RefreshCw size={12} className={spinning ? "animate-spin" : ""} />
    </button>
  );
}
