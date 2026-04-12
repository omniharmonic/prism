import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, MessageSquare, Filter } from "lucide-react";
import { matrixApi } from "../../lib/matrix/client";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { PlatformBadge } from "./PlatformBadge";
import { Spinner } from "../ui/Spinner";
import type { MatrixRoom } from "../../lib/matrix/types";
import type { RendererProps } from "../renderers/RendererProps";

function formatRelativeTime(ts: number): string {
  try {
    const date = new Date(ts);
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

export default function MessagesDashboard(_props: RendererProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const openTab = useUIStore((s) => s.openTab);

  const { data: rooms, isLoading, isError } = useQuery({
    queryKey: ["matrix", "rooms"],
    queryFn: matrixApi.getRooms,
    refetchInterval: 10_000,
    retry: 1,
  });

  // Group and filter rooms
  const { filteredRooms, platformGroups, platformCounts } = useMemo(() => {
    if (!rooms) return { filteredRooms: [], platformGroups: new Map<string, MatrixRoom[]>(), platformCounts: new Map<string, number>() };

    // Count per platform (unfiltered)
    const platformCounts = new Map<string, number>();
    for (const room of rooms) {
      const p = room.platform || "matrix";
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }

    // Apply filters
    const q = searchQuery.toLowerCase();
    const filtered = rooms.filter((room) => {
      if (platformFilter !== "all" && (room.platform || "matrix") !== platformFilter) return false;
      if (q && !room.name.toLowerCase().includes(q)) {
        // Also search last message body
        if (!room.last_message?.body.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // Sort: unread first, then by timestamp
    filtered.sort((a, b) => {
      if (a.unread_count > 0 && b.unread_count === 0) return -1;
      if (a.unread_count === 0 && b.unread_count > 0) return 1;
      const aTime = a.last_message?.timestamp || 0;
      const bTime = b.last_message?.timestamp || 0;
      return bTime - aTime;
    });

    // Group by platform
    const groups = new Map<string, MatrixRoom[]>();
    for (const room of filtered) {
      const p = room.platform || "matrix";
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(room);
    }

    return { filteredRooms: filtered, platformGroups: groups, platformCounts };
  }, [rooms, searchQuery, platformFilter]);

  const handleOpenThread = (room: MatrixRoom) => {
    openTab(`matrix:${room.room_id}`, room.name, "message-thread");
  };

  // Collect unique platforms for the filter dropdown
  const platforms = useMemo(() => {
    return Array.from(platformCounts.keys()).sort();
  }, [platformCounts]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={24} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <MessageSquare size={32} style={{ color: "var(--text-muted)" }} className="mx-auto" />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Could not connect to messaging service.
          </p>
        </div>
      </div>
    );
  }

  const totalUnread = rooms?.reduce((sum, r) => sum + r.unread_count, 0) || 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div
        className="flex items-center gap-4 px-6 py-4"
        style={{ borderBottom: "1px solid var(--glass-border)" }}
      >
        <div className="flex-1">
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Messages
          </h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {rooms?.length || 0} conversations
            {totalUnread > 0 && (
              <span style={{ color: "var(--color-accent)" }}> &middot; {totalUnread} unread</span>
            )}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div
        className="flex items-center gap-3 px-6 py-3"
        style={{ borderBottom: "1px solid var(--glass-border)" }}
      >
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
        >
          <Search size={13} style={{ color: "var(--text-muted)" }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="bg-transparent text-xs outline-none flex-1"
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
            <option value="all" style={{ background: "var(--bg-elevated)" }}>
              All platforms
            </option>
            {platforms.map((p) => {
              const config = getPlatformConfig(p);
              return (
                <option key={p} value={p} style={{ background: "var(--bg-elevated)" }}>
                  {config.label} ({platformCounts.get(p) || 0})
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-auto">
        {filteredRooms.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare size={24} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {searchQuery || platformFilter !== "all"
                ? "No conversations match your filters."
                : "No conversations yet."}
            </p>
          </div>
        ) : platformFilter === "all" ? (
          // Grouped by platform
          Array.from(platformGroups.entries()).map(([platform, platformRooms]) => {
            const config = getPlatformConfig(platform);
            const unreadCount = platformRooms.reduce((sum, r) => sum + r.unread_count, 0);
            return (
              <PlatformGroupSection
                key={platform}
                platform={platform}
                label={config.label}
                color={config.color}
                rooms={platformRooms}
                unreadCount={unreadCount}
                onOpenThread={handleOpenThread}
              />
            );
          })
        ) : (
          // Flat list when filtering by platform
          filteredRooms.map((room) => (
            <ConversationRow
              key={room.room_id}
              room={room}
              showPlatform={false}
              onClick={() => handleOpenThread(room)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PlatformGroupSection({
  label,
  color,
  rooms,
  unreadCount,
  onOpenThread,
}: {
  platform: string;
  label: string;
  color: string;
  rooms: MatrixRoom[];
  unreadCount: number;
  onOpenThread: (room: MatrixRoom) => void;
}) {
  return (
    <div>
      {/* Group header */}
      <div
        className="flex items-center gap-2 px-6 py-2 sticky top-0"
        style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--glass-border)" }}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {rooms.length}
        </span>
        {unreadCount > 0 && (
          <span
            className="text-[10px] px-1.5 rounded-full ml-auto"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            {unreadCount} unread
          </span>
        )}
      </div>

      {/* Rooms */}
      {rooms.map((room) => (
        <ConversationRow
          key={room.room_id}
          room={room}
          showPlatform={false}
          onClick={() => onOpenThread(room)}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  room,
  showPlatform,
  onClick,
}: {
  room: MatrixRoom;
  showPlatform: boolean;
  onClick: () => void;
}) {
  const timeStr = room.last_message ? formatRelativeTime(room.last_message.timestamp) : "";

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 px-6 py-3 hover:bg-[var(--glass-hover)] transition-colors text-left"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }}
    >
      {/* Avatar placeholder */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}
      >
        <MessageSquare size={14} style={{ color: "var(--text-muted)" }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm truncate"
            style={{
              color: "var(--text-primary)",
              fontWeight: room.unread_count > 0 ? 600 : 400,
            }}
          >
            {room.name}
          </span>
          {showPlatform && <PlatformBadge platform={room.platform || "matrix"} />}
          {timeStr && (
            <span className="ml-auto text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
              {timeStr}
            </span>
          )}
        </div>
        {room.last_message && (
          <div className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>
            <span style={{ color: "var(--text-secondary)" }}>{room.last_message.sender.split(":")[0].replace("@", "")}:</span>{" "}
            {room.last_message.body}
          </div>
        )}
      </div>

      {/* Unread badge */}
      {room.unread_count > 0 && (
        <span
          className="text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0 mt-1"
          style={{ background: "var(--color-accent)", color: "white", minWidth: 20, textAlign: "center" }}
        >
          {room.unread_count}
        </span>
      )}
    </button>
  );
}
