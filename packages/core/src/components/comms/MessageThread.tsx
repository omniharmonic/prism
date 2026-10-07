import "./messages.css";
import { messageInitials, messageColor } from "./messageAppearance";
import type { CSSProperties } from "react";
import { Fragment, useMemo, useRef } from "react";
import { useThreadReadingPosition } from "./useThreadReadingPosition";
import type { ThreadReadingIdentity } from "../../lib/messages/readingPosition";
import type { MatrixMessage } from "../../lib/matrix/types";

import { formatDate as fmtDate, formatDateTime as fmtDateTime, formatTime as fmtTime } from "../../lib/datetime/format";
interface MessageThreadProps {
  messages: MatrixMessage[];
  readingIdentity?: ThreadReadingIdentity;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

export function MessageThread(props: MessageThreadProps) {
  return <ScopedMessageThread key={JSON.stringify(props.readingIdentity ?? null)} {...props} />;
}

function ScopedMessageThread({
  messages,
  onLoadMore,
  hasMore,
  isLoadingMore,
  readingIdentity,
}: MessageThreadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reading = useThreadReadingPosition(containerRef, messages, readingIdentity);
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const ambiguousNames = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const message of messages) {
      const name = (message.sender_name || message.sender).trim().toLowerCase();
      const senders = names.get(name) ?? new Set<string>();
      senders.add(message.sender);
      names.set(name, senders);
    }
    return new Set(
      [...names]
        .filter(([, senders]) => senders.size > 1)
        .map(([name]) => name),
    );
  }, [messages]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={containerRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        className="workspace-message-thread prism-thread-content flex-1 min-h-0 overflow-auto px-4 py-4 space-y-4"
        style={{ overflowAnchor: "none" }}
        onScroll={reading.onScroll}
        onWheel={reading.userIntent}
        onTouchMove={reading.userIntent}
        onKeyDown={event => {if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key))reading.userIntent();}}
        onPointerDown={event => {if(event.target === event.currentTarget)reading.userIntent();}}
      >
        {hasMore && onLoadMore && (
          <button
            type="button"
            className="prism-earlier-messages block mx-auto text-xs"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore
              ? "Loading earlier messages…"
              : "Load earlier messages"}
          </button>
        )}
        {messages.length === 0 && (
          <p
            className="text-center text-sm py-8"
            style={{ color: "var(--text-muted)" }}
          >
            No messages to display yet.
          </p>
        )}
        {groups.map((group, index) => (
          <Fragment key={group[0].event_id}>
            {(index === 0 ||
              dayLabel(groups[index - 1][0]) !== dayLabel(group[0])) && (
              <div
                role="separator"
                aria-label={dayLabel(group[0])}
                className="flex items-center gap-3 py-2 text-[11px] text-[var(--text-muted)]"
              >
                <span className="h-px flex-1 bg-[var(--glass-border)]" />
                <span>{dayLabel(group[0])}</span>
                <span className="h-px flex-1 bg-[var(--glass-border)]" />
              </div>
            )}
            <MessageGroup
              messages={group}
              ambiguous={ambiguousNames.has(
                (group[0].sender_name || group[0].sender).trim().toLowerCase(),
              )}
            />
          </Fragment>
        ))}
      </div>
      {reading.missingPosition && (
        <div role="status" className="px-4 py-2 text-xs" style={{color:"var(--text-secondary)"}}>
          Your previous reading position is not in this loaded window. {hasMore && onLoadMore && <><button type="button" className="underline" onClick={onLoadMore} disabled={isLoadingMore}>{isLoadingMore ? "Loading earlier messages…" : "Load earlier messages"}</button> to look for it, or </>}
          <button type="button" onClick={reading.jump} className="underline">jump to latest</button>.
        </div>
      )}
      {reading.newMessages && (
        <button
          type="button"
          onClick={reading.jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-md"
          style={{ background: "var(--action-bg)", color: "var(--action-fg)" }}
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}

function groupMessages(messages: MatrixMessage[]): MatrixMessage[][] {
  const groups: MatrixMessage[][] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const prior = group?.at(-1);
    const sameDay =
      prior &&
      new Date(prior.timestamp).toDateString() ===
        new Date(message.timestamp).toDateString();
    if (
      prior &&
      prior.sender === message.sender &&
      prior.is_outgoing === message.is_outgoing &&
      prior.source === message.source &&
      sameDay &&
      message.timestamp > 0 &&
      message.timestamp >= prior.timestamp &&
      message.timestamp - prior.timestamp < 300_000
    )
      group!.push(message);
    else groups.push([message]);
  }
  return groups;
}

function MessageGroup({
  messages,
  ambiguous,
}: {
  messages: MatrixMessage[];
  ambiguous: boolean;
}) {
  const first = messages[0];
  const name = first.sender_name?.trim() || first.sender || "Unknown sender";
  const outgoing = first.is_outgoing;
  const initials = messageInitials(name);
  return (
    <article
      className={`prism-message-group flex ${outgoing ? "prism-message-outgoing flex-row-reverse" : ""}`}
      aria-label={`Messages from ${outgoing ? "You" : name}`}
    >
      <div
        aria-hidden="true"
        className="prism-message-avatar"
        style={
          {
            "--avatar-tone": messageColor(first.sender || name),
          } as CSSProperties
        }
      >
        {outgoing ? "Y" : initials}
      </div>
      <div
        className={`min-w-0 flex-1 flex flex-col ${outgoing ? "items-end" : "items-start"}`}
      >
        <div className="prism-message-byline flex flex-wrap items-baseline gap-x-2 gap-y-1 max-w-full">
          <span
            className="prism-sender font-semibold break-all"
            title={first.sender}
          >
            {outgoing ? "You" : name}
          </span>
          {ambiguous && !outgoing && (
            <span className="break-all" style={{ color: "var(--text-muted)" }}>
              {first.sender}
            </span>
          )}
          <time
            dateTime={
              validTime(first.timestamp)
                ? new Date(first.timestamp).toISOString()
                : undefined
            }
            title={
              validTime(first.timestamp)
                ? fmtDateTime(new Date(first.timestamp))
                : first.timestamp_label
            }
            style={{ color: "var(--text-muted)" }}
          >
            {formatTimestamp(first)}
          </time>
          {first.source === "legacy" && (
            <span
              title="Imported transcript: source event IDs and delivery direction are unavailable"
              style={{ color: "var(--text-muted)" }}
            >
              Imported
            </span>
          )}
        </div>
        {messages.map((message) => (
          <div
            key={message.event_id}
            data-message-id={message.event_id}
            className="workspace-message-body prism-message-bubble mb-1"
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {message.redacted ? (
              <span className="italic text-[var(--text-muted)]">
                Message removed
              </span>
            ) : (
              <MessageText text={message.body} />
            )}
            {message.truncated && (
              <span className="block text-xs mt-1">
                This source message is too long to display in full.
              </span>
            )}
            {message.msg_type !== "m.text" && message.media_url && (
              <span
                className="block text-xs mt-1"
                style={{ color: "var(--text-secondary)" }}
              >
                Attachment · {message.msg_type.replace("m.", "")}
              </span>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

function validTime(value: number): boolean {
  return value > 0 && Number.isFinite(new Date(value).getTime());
}

function formatTimestamp(message: MatrixMessage): string {
  if (!validTime(message.timestamp))
    return message.timestamp_label || "Time unavailable";
  return fmtTime(message.timestamp, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(message: MatrixMessage): string {
  if (!validTime(message.timestamp)) return "Date unavailable";
  return fmtDate(message.timestamp, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Preserve plain source text exactly, including markup; only web URLs become links. */
function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"'`]+)/gi);
  return (
    <>
      {parts.map((part, index) => {
        if (!/^https?:\/\//i.test(part))
          return <Fragment key={index}>{part}</Fragment>;
        const href = part.replace(/[.,;!?)}\]]+$/, "");
        try {
          const url = new URL(href);
          if (url.username || url.password)
            return <Fragment key={index}>{part}</Fragment>;
          return (
            <Fragment key={index}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring text-[var(--text-accent)] underline underline-offset-2"
              >
                {href}
              </a>
              {part.slice(href.length)}
            </Fragment>
          );
        } catch {
          return <Fragment key={index}>{part}</Fragment>;
        }
      })}
    </>
  );
}
