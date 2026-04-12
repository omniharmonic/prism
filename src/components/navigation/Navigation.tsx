import { useState } from "react";
import { Search, Inbox as InboxIcon, Calendar, Plus, MessageSquare, PenSquare } from "lucide-react";
import { Input } from "../ui/Input";
import { ProjectTree } from "./ProjectTree";
import { SearchPanel } from "./SearchPanel";
import { NewContentMenu } from "./NewContentMenu";
import { Inbox } from "./Inbox";
import { CalendarMini } from "./CalendarMini";
import { useDebounce } from "use-debounce";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { ComposeMessage } from "../comms/ComposeMessage";

export function Navigation() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery] = useDebounce(searchQuery, 200);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const sidebarLabel = useSettingsStore((s) => s.sidebarLabel);
  const openTab = useUIStore((s) => s.openTab);

  const handleOpenMessagesDashboard = () => {
    openTab("messages-dashboard", "Messages", "messages-dashboard" as import("../../lib/types").ContentType);
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--glass-border)",
      }}
    >
      {/* Search */}
      <div className="p-2">
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
        <div className="flex-1 overflow-auto">
          {/* Unified Inbox */}
          <NavSection
            label="Inbox"
            icon={<InboxIcon size={14} />}
            action={
              <button
                onClick={(e) => { e.stopPropagation(); setShowCompose(true); }}
                className="p-0.5 rounded hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--text-muted)" }}
                title="Compose message"
              >
                <PenSquare size={11} />
              </button>
            }
          >
            <Inbox />
          </NavSection>

          {/* Messages Dashboard */}
          <button
            onClick={handleOpenMessagesDashboard}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            <MessageSquare size={13} />
            <span>Messages</span>
          </button>

          {/* Calendar — today's events */}
          <NavSection label="Calendar" icon={<Calendar size={14} />}>
            <CalendarMini />
          </NavSection>

          {/* Projects / vault notes */}
          <NavSection label={sidebarLabel} defaultOpen>
            <ProjectTree />
          </NavSection>
        </div>
      )}

      {/* New button */}
      <div className="p-2 relative" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <button
          onClick={() => setShowNewMenu(!showNewMenu)}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          <Plus size={14} />
          New...
        </button>
        {showNewMenu && <NewContentMenu onClose={() => setShowNewMenu(false)} />}
      </div>

      {/* Compose message modal */}
      {showCompose && <ComposeMessage onClose={() => setShowCompose(false)} />}
    </div>
  );
}

function NavSection({
  label,
  icon,
  defaultOpen = false,
  action,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <div className="flex items-center">
        <button
          onClick={() => setOpen(!open)}
          className="flex-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium uppercase tracking-wider hover:bg-[var(--glass-hover)] transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="text-[10px]">{open ? "▾" : "▸"}</span>
          {icon}
          {label}
        </button>
        {action && <div className="pr-2">{action}</div>}
      </div>
      {open && children}
    </div>
  );
}
