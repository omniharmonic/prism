import { useState } from "react";
import { Search, Calendar, Plus, MessageSquare, PenSquare, Bot } from "lucide-react";
import { Input } from "../ui/Input";
import { ProjectTree } from "./ProjectTree";
import { SearchPanel } from "./SearchPanel";
import { NewContentMenu } from "./NewContentMenu";
import { useDebounce } from "use-debounce";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { ComposeMessage } from "../comms/ComposeMessage";
import type { ContentType } from "../../lib/types";

export function Navigation() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery] = useDebounce(searchQuery, 200);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const sidebarLabel = useSettingsStore((s) => s.sidebarLabel);
  const openTab = useUIStore((s) => s.openTab);

  const handleOpenMessages = () => {
    openTab("vault-messages", "Messages", "vault-messages" as ContentType);
  };

  const handleOpenCalendar = () => {
    openTab("calendar-dashboard", "Calendar", "calendar-dashboard" as ContentType);
  };

  const handleOpenAgentActivity = () => {
    openTab("agent-activity", "Agent", "agent-activity" as ContentType);
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
          {/* Quick-access tabs */}
          <div className="px-2 py-1.5 space-y-0.5">
            <button
              onClick={handleOpenMessages}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-secondary)" }}
            >
              <MessageSquare size={14} />
              <span className="flex-1 text-left">Messages</span>
              <button
                onClick={(e) => { e.stopPropagation(); setShowCompose(true); }}
                className="p-0.5 rounded hover:bg-[var(--glass-active)] transition-colors"
                style={{ color: "var(--text-muted)" }}
                title="Compose message"
              >
                <PenSquare size={11} />
              </button>
            </button>
            <button
              onClick={handleOpenCalendar}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-secondary)" }}
            >
              <Calendar size={14} />
              <span>Calendar</span>
            </button>
            <button
              onClick={handleOpenAgentActivity}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-secondary)" }}
            >
              <Bot size={14} />
              <span>Agent</span>
            </button>
          </div>

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
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium uppercase tracking-wider hover:bg-[var(--glass-hover)] transition-colors"
        style={{ color: "var(--text-muted)" }}
      >
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && children}
    </div>
  );
}
