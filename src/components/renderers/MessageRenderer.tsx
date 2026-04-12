import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RendererProps } from "./RendererProps";
import { matrixApi } from "../../lib/matrix/client";
import { MessageThread } from "../comms/MessageThread";
import { MessageComposer } from "../comms/MessageComposer";
import { PlatformBadge } from "../comms/PlatformBadge";

export default function MessageRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const roomId = (meta?.matrixRoomId as string) || (meta?.matrix_room_id as string) || note.id.replace("matrix:", "");
  const platform = (meta?.platform as string) || "matrix";
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["matrix", "messages", roomId],
    queryFn: () => matrixApi.getMessages(roomId, 50),
    enabled: !!roomId,
  });

  const handleSend = useCallback(async (body: string) => {
    await matrixApi.sendMessage(roomId, body);
    queryClient.invalidateQueries({ queryKey: ["matrix", "messages", roomId] });
  }, [roomId, queryClient]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading messages...</div>
      </div>
    );
  }

  // Reverse messages so oldest are at top (Matrix returns newest first with dir=b)
  const messages = [...(data?.messages || [])].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <PlatformBadge platform={platform} />
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {note.path?.split("/").pop() || "Chat"}
        </span>
      </div>

      {/* Messages */}
      <MessageThread
        messages={messages}
        hasMore={data?.has_more}
      />

      {/* Composer */}
      <MessageComposer onSend={handleSend} />
    </div>
  );
}
