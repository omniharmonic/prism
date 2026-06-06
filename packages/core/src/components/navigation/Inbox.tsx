import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, ChevronDown, ChevronRight } from "lucide-react";
import { matrixApi } from "../../lib/matrix/client";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { Spinner } from "../ui/Spinner";
import type { MatrixRoom } from "../../lib/matrix/types";

interface PlatformGroup {
  platform: string;
  label: string;
  color: string;
  rooms: MatrixRoom[];
  unreadCount: number;
}

export function Inbox() {
  const { data: rooms, isLoading, isError } = useQuery({
    queryKey: ["matrix", "rooms"],
    queryFn: matrixApi.getRooms,
    refetchInterval: 10_000,
    retry: 1,
  });

  const openTab = useUIStore((s) => s.openTab);

  // Group rooms by platform
  const groups = useMemo(() => {
    if (!rooms || rooms.length === 0) return [];

    const byPlatform = new Map<string, MatrixRoom[]>();
    for (const room of rooms) {
      const platform = room.platform || "matrix";
      if (!byPlatform.has(platform)) byPlatform.set(platform, []);
      byPlatform.get(platform)!.push(room);
    }

    const result: PlatformGroup[] = [];
    for (const [platform, platformRooms] of byPlatform) {
      const config = getPlatformConfig(platform);
      const unreadCount = platformRooms.reduce((sum, r) => sum + r.unread_count, 0);
      // Sort: unread first, then by last message time
      platformRooms.sort((a, b) => {
        if (a.unread_count > 0 && b.unread_count === 0) return -1;
        if (a.unread_count === 0 && b.unread_count > 0) return 1;
        const aTime = a.last_message?.timestamp || 0;
        const bTime = b.last_message?.timestamp || 0;
        return bTime - aTime;
      });
      result.push({
        platform,
        label: config.label,
        color: config.color,
        rooms: platformRooms,
        unreadCount,
      });
    }

    // Sort groups: unread first, then alphabetical
    result.sort((a, b) => {
      if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
      if (a.unreadCount === 0 && b.unreadCount > 0) return 1;
      return a.label.localeCompare(b.label);
    });

    return result;
  }, [rooms]);

  if (isError) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Messaging unavailable
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-2">
        <Spinner size={14} />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        No conversations
      </div>
    );
  }

  const handleOpenThread = (room: MatrixRoom) => {
    openTab(`matrix:${room.room_id}`, room.name, "message-thread");
  };

  return (
    <div className="py-0.5">
      {groups.map((group) => (
        <PlatformSection
          key={group.platform}
          group={group}
          onOpenThread={handleOpenThread}
        />
      ))}
    </div>
  );
}

function PlatformSection({
  group,
  onOpenThread,
}: {
  group: PlatformGroup;
  onOpenThread: (room: MatrixRoom) => void;
}) {
  const [open, setOpen] = useState(true);
  // Show max 5 rooms when collapsed-expanded, show all when "Show all" clicked
  const [showAll, setShowAll] = useState(false);
  const displayRooms = showAll ? group.rooms : group.rooms.slice(0, 5);
  const hasMore = group.rooms.length > 5;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1 text-xs hover:bg-[var(--glass-hover)] transition-colors"
        style={{ color: "var(--text-secondary)" }}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: group.color }}
        />
        <span className="font-medium">{group.label}</span>
        <span className="ml-auto text-[10px]" style={{ color: "var(--text-muted)" }}>
          {group.rooms.length}
        </span>
        {group.unreadCount > 0 && (
          <span
            className="text-[10px] px-1.5 rounded-full"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            {group.unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div>
          {displayRooms.map((room) => (
            <RoomRow key={room.room_id} room={room} onClick={() => onOpenThread(room)} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-3 py-1 text-[10px] hover:bg-[var(--glass-hover)] transition-colors"
              style={{ color: "var(--text-muted)", paddingLeft: 36 }}
            >
              Show all {group.rooms.length} conversations...
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RoomRow({ room, onClick }: { room: MatrixRoom; onClick: () => void }) {
  const timeStr = room.last_message
    ? formatRelativeTime(room.last_message.timestamp)
    : "";

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-2 px-3 py-1.5 hover:bg-[var(--glass-hover)] transition-colors"
      style={{ paddingLeft: 28 }}
    >
      <MessageSquare
        size={13}
        className="mt-0.5 flex-shrink-0"
        style={{ color: "var(--text-muted)" }}
      />
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1">
          <span
            className="text-xs truncate"
            style={{
              color: "var(--text-primary)",
              fontWeight: room.unread_count > 0 ? 600 : 400,
            }}
          >
            {room.name}
          </span>
          {timeStr && (
            <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>
              {timeStr}
            </span>
          )}
        </div>
        {room.last_message && (
          <div
            className="text-[11px] truncate mt-0.5"
            style={{ color: "var(--text-muted)" }}
          >
            {room.last_message.body}
          </div>
        )}
      </div>
      {room.unread_count > 0 && (
        <span
          className="text-[10px] px-1 rounded-full mt-0.5 flex-shrink-0"
          style={{ background: "var(--color-accent)", color: "white", minWidth: 16, textAlign: "center" }}
        >
          {room.unread_count}
        </span>
      )}
    </button>
  );
}

function formatRelativeTime(ts: number): string {
  try {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
