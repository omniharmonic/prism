import { useRef, useEffect } from "react";
import { formatDistanceToNow } from "date-fns";
import type { MatrixMessage } from "../../lib/matrix/types";

interface MessageThreadProps {
  messages: MatrixMessage[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

export function MessageThread({ messages, onLoadMore, hasMore, isLoadingMore }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on initial load
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [messages.length]);

  // Load more on scroll to top
  const handleScroll = () => {
    if (!containerRef.current || !hasMore || isLoadingMore) return;
    if (containerRef.current.scrollTop < 100) {
      onLoadMore?.();
    }
  };

  // Group consecutive messages from the same sender
  const groups = groupMessages(messages);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto px-4 py-3 space-y-3"
    >
      {isLoadingMore && (
        <div className="text-center text-xs py-2" style={{ color: "var(--text-muted)" }}>
          Loading older messages...
        </div>
      )}

      {groups.map((group, i) => (
        <MessageGroup key={group.messages[0].event_id} group={group} prevGroup={groups[i - 1]} />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}

interface MessageGroupData {
  sender: string;
  senderName: string;
  isOutgoing: boolean;
  messages: MatrixMessage[];
}

function groupMessages(messages: MatrixMessage[]): MessageGroupData[] {
  const groups: MessageGroupData[] = [];

  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (last && last.sender === msg.sender) {
      last.messages.push(msg);
    } else {
      // Use display name, falling back to cleaned-up Matrix ID
      let displayName = msg.sender_name || "";
      if (!displayName) {
        // Clean up Matrix IDs: @telegram_12345:localhost → "telegram_12345"
        // @whatsapp_1234:localhost → "whatsapp_1234"
        const localpart = msg.sender.split(":")[0].replace("@", "");
        // Strip bridge prefixes for readability
        displayName = localpart
          .replace(/^telegram_\d+$/, "User")
          .replace(/^whatsapp_\d+$/, "User")
          .replace(/^discord_\d+$/, "User")
          .replace(/^signal_\d+$/, "User")
          .replace(/^instagram_\d+$/, "User");
        if (displayName === "User") displayName = localpart; // keep original if no good name
      }
      groups.push({
        sender: msg.sender,
        senderName: displayName,
        isOutgoing: msg.is_outgoing,
        messages: [msg],
      });
    }
  }

  return groups;
}

function MessageGroup({ group, prevGroup }: { group: MessageGroupData; prevGroup?: MessageGroupData }) {
  // Show timestamp separator if >5 min gap from previous group
  const showTimestamp = !prevGroup ||
    (group.messages[0].timestamp - prevGroup.messages[prevGroup.messages.length - 1].timestamp) > 300_000;

  return (
    <div>
      {showTimestamp && (
        <div className="text-center text-xs py-2" style={{ color: "var(--text-muted)" }}>
          {formatTimestamp(group.messages[0].timestamp)}
        </div>
      )}

      <div className={`flex flex-col ${group.isOutgoing ? "items-end" : "items-start"}`}>
        {!group.isOutgoing && (
          <div className="text-xs font-medium mb-0.5 px-1" style={{ color: "var(--text-secondary)" }}>
            {group.senderName}
          </div>
        )}

        {group.messages.map((msg) => (
          <div
            key={msg.event_id}
            className="max-w-[75%] px-3 py-1.5 rounded-xl text-sm mb-0.5"
            style={{
              background: group.isOutgoing ? "var(--color-accent)" : "var(--glass)",
              color: group.isOutgoing ? "white" : "var(--text-primary)",
              borderRadius: group.isOutgoing
                ? "18px 18px 4px 18px"
                : "18px 18px 18px 4px",
            }}
          >
            {msg.body}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: number): string {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}
