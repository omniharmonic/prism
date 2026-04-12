import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, MessageSquare, Filter, ChevronDown, ChevronRight, Link2, User } from "lucide-react";
import { vaultApi } from "../../lib/parachute/client";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { Spinner } from "../ui/Spinner";
import type { Note } from "../../lib/types";
import type { RendererProps } from "../renderers/RendererProps";

function formatRelativeTime(ts: number | string): string {
  try {
    const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function VaultMessagesDashboard(_props: RendererProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const openTab = useUIStore((s) => s.openTab);

  // Fetch message-thread notes from Parachute
  const { data: notes, isLoading } = useQuery({
    queryKey: ["vault", "notes", { tag: "message-thread" }],
    queryFn: () => vaultApi.listNotes({ tag: "message-thread", limit: 500 }),
    refetchInterval: 30_000,
  });

  const { platformGroups, platformCounts, totalCount } = useMemo(() => {
    if (!notes) return { platformGroups: new Map<string, Note[]>(), platformCounts: new Map<string, number>(), totalCount: 0 };

    const platformCounts = new Map<string, number>();
    for (const note of notes) {
      const p = (note.metadata as Record<string, unknown>)?.platform as string || "matrix";
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }

    const q = searchQuery.toLowerCase();
    const filtered = notes.filter((note) => {
      const meta = (note.metadata || {}) as Record<string, unknown>;
      const platform = (meta.platform as string) || "matrix";
      if (platformFilter !== "all" && platform !== platformFilter) return false;
      if (q) {
        const name = (note.path || "").split("/").pop() || "";
        const content = note.content || "";
        if (!name.toLowerCase().includes(q) && !content.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // Sort by lastMessageAt descending
    filtered.sort((a, b) => {
      const aTime = ((a.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      const bTime = ((b.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      return bTime - aTime;
    });

    const groups = new Map<string, Note[]>();
    for (const note of filtered) {
      const p = ((note.metadata || {}) as Record<string, unknown>).platform as string || "matrix";
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(note);
    }

    return { platformGroups: groups, platformCounts, totalCount: notes.length };
  }, [notes, searchQuery, platformFilter]);

  const handleOpenThread = (note: Note) => {
    const name = (note.path || "").split("/").pop() || note.id;
    openTab(note.id, name, "document");
  };

  const platforms = useMemo(() => Array.from(platformCounts.keys()).sort(), [platformCounts]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full"><Spinner size={24} /></div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-3" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div className="flex-1">
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Vault Messages</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {totalCount} conversations indexed in Parachute
            <span style={{ color: "var(--text-muted)" }}> · searchable · linked to people</span>
          </p>
        </div>

        {/* Search — this searches Parachute, so it finds content across all messages */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg max-w-xs"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
        >
          <Search size={13} style={{ color: "var(--text-muted)" }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="bg-transparent text-xs outline-none w-40"
            style={{ color: "var(--text-primary)" }}
          />
        </div>

        {/* Platform filter */}
        <div className="flex items-center gap-1.5">
          <Filter size={12} style={{ color: "var(--text-muted)" }} />
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="h-7 rounded-md px-2 text-xs outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          >
            <option value="all" style={{ background: "var(--bg-elevated)" }}>All platforms</option>
            {platforms.map((p) => {
              const config = getPlatformConfig(p);
              return <option key={p} value={p} style={{ background: "var(--bg-elevated)" }}>{config.label} ({platformCounts.get(p) || 0})</option>;
            })}
          </select>
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-auto">
        {platformGroups.size === 0 ? (
          <div className="text-center py-12">
            <MessageSquare size={24} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {searchQuery || platformFilter !== "all" ? "No conversations match your filters." : "No indexed conversations yet. Wait for sync to complete."}
            </p>
          </div>
        ) : (
          Array.from(platformGroups.entries()).map(([platform, platformNotes]) => {
            const config = getPlatformConfig(platform);
            return (
              <CollapsibleSection
                key={platform}
                label={config.label}
                color={config.color}
                notes={platformNotes}
                onOpen={handleOpenThread}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({
  label, color, notes, onOpen,
}: {
  label: string; color: string; notes: Note[]; onOpen: (note: Note) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-5 py-2 sticky top-0 hover:bg-[var(--glass-hover)] transition-colors"
        style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--glass-border)" }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{notes.length}</span>
      </button>

      {open && notes.map((note) => (
        <ConversationRow key={note.id} note={note} onClick={() => onOpen(note)} />
      ))}
    </div>
  );
}

function ConversationRow({ note, onClick }: { note: Note; onClick: () => void }) {
  const meta = (note.metadata || {}) as Record<string, unknown>;
  const name = (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Unknown";
  const participants = (meta.participants as string[]) || [];
  const lastMessageAt = meta.lastMessageAt as number;
  const messageCount = meta.messageCount as number;
  const timeStr = lastMessageAt ? formatRelativeTime(lastMessageAt) : "";

  // Get last message from content (last non-empty line)
  const lines = (note.content || "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const lastLine = lines[lines.length - 1] || "";

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 px-6 py-2.5 hover:bg-[var(--glass-hover)] transition-colors text-left"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }}
    >
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
        <MessageSquare size={13} style={{ color: "var(--text-muted)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate capitalize" style={{ color: "var(--text-primary)" }}>
            {name}
          </span>
          {timeStr && <span className="ml-auto text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>{timeStr}</span>}
        </div>
        {lastLine && (
          <div className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>
            {lastLine}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1">
          {participants.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <User size={9} /> {participants.length}
            </span>
          )}
          {messageCount && (
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {messageCount} msgs
            </span>
          )}
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "var(--color-accent)" }}>
            <Link2 size={9} /> vault
          </span>
        </div>
      </div>
    </button>
  );
}
