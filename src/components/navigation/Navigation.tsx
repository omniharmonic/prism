import { useState } from "react";
import { Search, Inbox as InboxIcon, Calendar, Plus } from "lucide-react";
import { Input } from "../ui/Input";
import { ProjectTree } from "./ProjectTree";
import { SearchPanel } from "./SearchPanel";
import { NewContentMenu } from "./NewContentMenu";
import { Inbox } from "./Inbox";
import { CalendarMini } from "./CalendarMini";
import { useDebounce } from "use-debounce";

export function Navigation() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery] = useDebounce(searchQuery, 200);
  const [showNewMenu, setShowNewMenu] = useState(false);

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
          <NavSection label="Inbox" icon={<InboxIcon size={14} />}>
            <Inbox />
          </NavSection>

          {/* Calendar — today's events */}
          <NavSection label="Calendar" icon={<Calendar size={14} />}>
            <CalendarMini />
          </NavSection>

          {/* Projects / vault notes */}
          <NavSection label="Projects" defaultOpen>
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
    </div>
  );
}

function NavSection({
  label,
  icon,
  defaultOpen = false,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
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
        {icon}
        {label}
      </button>
      {open && children}
    </div>
  );
}
