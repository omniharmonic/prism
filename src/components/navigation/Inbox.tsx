import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { matrixApi } from "../../lib/matrix/client";
import { useUIStore } from "../../app/stores/ui";
import { PlatformBadge } from "../comms/PlatformBadge";
import { Spinner } from "../ui/Spinner";
import type { MatrixRoom } from "../../lib/matrix/types";

export function Inbox() {
  const { data: rooms, isLoading, isError } = useQuery({
    queryKey: ["matrix", "rooms"],
    queryFn: matrixApi.getRooms,
    refetchInterval: 10_000,
    retry: 1,
  });

  const openTab = useUIStore((s) => s.openTab);

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

  // Show rooms with unread messages, or most recent if none unread
  const unreadRooms = (rooms || []).filter((r) => r.unread_count > 0);
  const displayRooms = unreadRooms.length > 0 ? unreadRooms : (rooms || []).slice(0, 5);

  if (displayRooms.length === 0) {
    return (
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        No unread messages
      </div>
    );
  }

  const handleOpenThread = (room: MatrixRoom) => {
    // Open as a virtual tab (message threads live in Matrix, not Parachute)
    openTab(
      `matrix:${room.room_id}`,
      room.name,
      "message-thread",
    );
  };

  return (
    <div className="py-0.5">
      {displayRooms.map((room) => (
        <button
          key={room.room_id}
          onClick={() => handleOpenThread(room)}
          className="w-full flex items-start gap-2 px-3 py-1.5 hover:bg-[var(--glass-hover)] transition-colors"
        >
          <MessageSquare size={14} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} />
          <div className="flex-1 min-w-0 text-left">
            <div className="flex items-center gap-1.5">
              <span className="text-sm truncate" style={{ color: "var(--text-primary)" }}>
                {room.name}
              </span>
              <PlatformBadge platform={room.platform} />
              {room.unread_count > 0 && (
                <span
                  className="ml-auto text-xs px-1.5 rounded-full flex-shrink-0"
                  style={{ background: "var(--color-accent)", color: "white" }}
                >
                  {room.unread_count}
                </span>
              )}
            </div>
            {room.last_message && (
              <div className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>
                {room.last_message.body}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
