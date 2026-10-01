import { useRef, useLayoutEffect, useState } from "react";
import type { MatrixMessage } from "../../lib/matrix/types";

interface MessageThreadProps {
  messages: MatrixMessage[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

export function MessageThread({ messages, onLoadMore, hasMore, isLoadingMore }: MessageThreadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previous = useRef<{ first?: string; last?: string; height: number; top: number }>({ height: 0, top: 0 });
  const [newMessages, setNewMessages] = useState(false);
  const first = messages[0]?.event_id;
  const last = messages.at(-1)?.event_id;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const before = previous.current;
    const prepended = before.first && first !== before.first && messages.some((message) => message.event_id === before.first);
    if (prepended) {
      container.scrollTop = before.top + container.scrollHeight - before.height;
    } else if (!before.last || nearBottom.current) {
      container.scrollTop = container.scrollHeight;
      setNewMessages(false);
    } else if (last !== before.last) {
      setNewMessages(true);
    }
    previous.current = { first, last, height: container.scrollHeight, top: container.scrollTop };
  }, [messages, first, last]);

  const jump = () => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    nearBottom.current = true;
    setNewMessages(false);
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={containerRef} role="region" aria-label="Conversation messages" tabIndex={0}
        className="workspace-message-thread flex-1 min-h-0 overflow-auto px-4 py-4 space-y-4"
        onScroll={() => {
          const container = containerRef.current;
          if (!container) return;
          previous.current.top = container.scrollTop;
          previous.current.height = container.scrollHeight;
          nearBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight < 64;
          if (nearBottom.current) setNewMessages(false);
        }}>
        {hasMore && onLoadMore && <button type="button" className="block mx-auto text-xs underline p-2" onClick={onLoadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading earlier messages…" : "Load earlier messages"}
        </button>}
        {messages.length === 0 && <p className="text-center text-sm py-8" style={{ color: "var(--text-muted)" }}>No messages to display yet.</p>}
        {groupMessages(messages).map((group) => <MessageGroup key={group[0].event_id} messages={group} />)}
      </div>
      {newMessages && <button type="button" onClick={jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-md"
        style={{ background: "var(--action-bg)", color: "var(--action-fg)" }}>New messages ↓</button>}
    </div>
  );
}

function groupMessages(messages: MatrixMessage[]): MatrixMessage[][] {
  const groups: MatrixMessage[][] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const prior = group?.at(-1);
    const sameDay = prior && new Date(prior.timestamp).toDateString() === new Date(message.timestamp).toDateString();
    if (prior && prior.sender === message.sender && prior.is_outgoing === message.is_outgoing && prior.source === message.source &&
      sameDay && message.timestamp > 0 && message.timestamp >= prior.timestamp && message.timestamp - prior.timestamp < 300_000) group!.push(message);
    else groups.push([message]);
  }
  return groups;
}

function MessageGroup({ messages }: { messages: MatrixMessage[] }) {
  const first = messages[0];
  const name = first.sender_name?.trim() || first.sender || "Unknown sender";
  const outgoing = first.is_outgoing;
  const initials = name.replace(/^@/, "").split(/[\s_]+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (
    <article className={`flex gap-2.5 ${outgoing ? "flex-row-reverse" : ""}`} aria-label={`Messages from ${outgoing ? "You" : name}`}>
      <div aria-hidden="true" className="rounded-full flex items-center justify-center shrink-0 text-xs font-medium"
        style={{ width: 30, height: 30, background: "var(--surface-selected)", color: "var(--text-secondary)" }}>{outgoing ? "Y" : initials}</div>
      <div className={`min-w-0 flex-1 flex flex-col ${outgoing ? "items-end" : "items-start"}`}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-1 text-xs max-w-full">
          <span className="font-semibold break-all" title={first.sender}>{outgoing ? "You" : name}</span>
          <span style={{ color: "var(--text-muted)" }}>{formatTimestamp(first)}</span>
          {first.source === "legacy" && <span title="Imported transcript: source event IDs and delivery direction are unavailable" style={{ color: "var(--text-muted)" }}>Imported</span>}
        </div>
        {messages.map((message) => <div key={message.event_id} data-message-id={message.event_id}
          className="workspace-message-body rounded-lg px-3 py-2 text-sm mb-1 max-w-full"
          style={{ background: outgoing ? "var(--surface-selected)" : "var(--glass-hover)", color: "var(--text-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {message.body}
          {message.msg_type !== "m.text" && message.media_url && <span className="block text-xs mt-1" style={{ color: "var(--text-secondary)" }}>Attachment · {message.msg_type.replace("m.", "")}</span>}
        </div>)}
      </div>
    </article>
  );
}

function formatTimestamp(message: MatrixMessage): string {
  if (!Number.isFinite(message.timestamp) || message.timestamp <= 0) return message.timestamp_label || "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(message.timestamp);
}
