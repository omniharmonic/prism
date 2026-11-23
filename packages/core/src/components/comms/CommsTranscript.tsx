/**
 * A conversation read from the Comms API (`/api/comms/threads/:id/messages`) in Prism's own look
 * (D19: Prism's look, Comms' behaviour). Behaviour shared with the Comms app: runs grouped by
 * sender + direction + day + 60-minute gap (lib/comms/model.ts), a tail on the last bubble of a
 * run, a time header after an hour of quiet, avatars, media through the signed media proxy,
 * reactions, link previews and reply quotes. Read-only: sending is a later stage.
 */
import "./messages.css";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FileText, MapPin, Play, Reply } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { backoff, groupRuns, sentAtMs, type MessageRun } from "../../lib/comms/model";
import type { CommsAttachment, CommsAvatar as Avatar, CommsMessage, CommsSpan, CommsThread } from "../../lib/comms/types";
import { formatDate as fmtDate, formatDateTime as fmtDateTime, formatTime as fmtTime } from "../../lib/datetime/format";
import { serverFetch } from "../../lib/transport/serverFetch";
import { downloadBlob } from "../../lib/saveFile";
import { messageColor, messageInitials } from "./messageAppearance";
import { useThreadReadingPosition } from "./useThreadReadingPosition";

/** Older pages kept at most (×50 messages); past it the archived transcript is the way back. */
const MAX_PAGES = 20;

export const commsMessagesKey = (scope: string | null, threadId: string) => ["comms", "messages", scope, threadId] as const;
/** The newest page only: the ONE read that polls (older pages are read once, on request). */
export const commsHeadKey = (scope: string | null, threadId: string) => ["comms", "messages-head", scope, threadId] as const;


// ── avatar ────────────────────────────────────────────────────────────────────

/** A person's or group's picture (signed media token) or the Prism monogram in a stable tone. */
export function CommsAvatar({ avatar, name, identity, size }: { avatar: Avatar | null | undefined; name: string; identity: string; size?: number }) {
  const vault = useVaultClient();
  const [failed, setFailed] = useState(false);
  const token = avatar && "token" in avatar ? avatar.token : avatar && "members" in avatar ? avatar.members?.find((m): m is { token: string } => "token" in m)?.token : undefined;
  const monogram = avatar && "monogram" in avatar && avatar.monogram ? avatar.monogram.slice(0, 2).toUpperCase() : messageInitials(name);
  const style = { "--avatar-tone": messageColor(identity), ...(size ? { width: size, height: size } : {}) } as CSSProperties;
  return (
    <div aria-hidden="true" className="prism-message-avatar" style={style}>
      {token && vault.comms && !failed ? (
        <img className="prism-comms-avatar-img" src={vault.comms.mediaUrl(token)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        monogram
      )}
    </div>
  );
}

// ── rich text ─────────────────────────────────────────────────────────────────

const SAFE_HREF = /^(https?:|mailto:)/i;
function Spans({ spans }: { spans: CommsSpan[] }) {
  return <>{spans.map((s, i) => <Span key={i} span={s} />)}</>;
}
function Span({ span }: { span: CommsSpan }): ReactNode {
  switch (span.t) {
    case "text": return span.v;
    case "br": return <br />;
    case "bold": return <strong><Spans spans={span.c} /></strong>;
    case "italic": return <em><Spans spans={span.c} /></em>;
    case "strike": return <s><Spans spans={span.c} /></s>;
    case "code": return <code className="prism-comms-code"><Spans spans={span.c} /></code>;
    case "pre": return <pre className="prism-comms-pre">{span.v}</pre>;
    case "quote": return <blockquote className="prism-comms-quote"><Spans spans={span.c} /></blockquote>;
    case "li": return <span className="prism-comms-li"><Spans spans={span.c} /></span>;
    case "mention": return <span className="prism-comms-mention">@{span.name}</span>;
    case "link": {
      let ok = SAFE_HREF.test(span.href);
      try { if (ok && new URL(span.href).username) ok = false; } catch { ok = false; }
      return ok ? (
        <a href={span.href} target="_blank" rel="noopener noreferrer" className="focus-ring text-[var(--text-accent)] underline underline-offset-2"><Spans spans={span.c} /></a>
      ) : <Spans spans={span.c} />;
    }
    default: return null;
  }
}

// ── attachments, link previews ───────────────────────────────────────────────

const duration = (ms?: number) => {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const bytes = (n?: number) => (!n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Audio/video in the native shell: nothing is fetched until the person presses Play; then one
 * bearer fetch gives a blob: URL (revoked when the bubble goes away) and the player starts.
 */
function LazyPlayer({ a, load, thumb }: { a: CommsAttachment; load: (token: string) => Promise<string>; thumb: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const label = a.kind === "voice" ? "Voice message" : a.kind === "video" ? a.name || "Video" : a.name || "Audio";
  if (src)
    return a.kind === "video"
      ? <video className="prism-comms-media" controls autoPlay src={src} aria-label={label} style={a.w && a.h ? { aspectRatio: `${a.w} / ${a.h}` } : undefined} />
      : <span className="prism-comms-audio"><span className="prism-comms-attachment-label">{label}{a.durationMs ? ` · ${duration(a.durationMs)}` : ""}</span><audio controls autoPlay src={src} aria-label={label} /></span>;
  return (
    <span className="prism-comms-lazy" data-kind={a.kind}>
      {a.kind === "video" && thumb && <img className="prism-comms-media" src={thumb} alt="" loading="lazy" />}
      <button
        type="button"
        className="prism-comms-file-action focus-ring"
        disabled={state === "loading"}
        onClick={() => {
          setState("loading");
          load(a.mediaToken!).then((u) => { setSrc(u); setState("idle"); }, () => setState("failed"));
        }}
      >
        <Play size={13} aria-hidden="true" /> {state === "loading" ? "Loading…" : `Play ${label.charAt(0).toLowerCase()}${label.slice(1)}`}{a.durationMs ? ` · ${duration(a.durationMs)}` : ""}
      </button>
      {state === "failed" && <span role="alert" className="prism-comms-attachment-label">Couldn’t load this {a.kind === "video" ? "video" : "recording"}.</span>}
    </span>
  );
}

function AttachmentView({ a, url, load }: { a: CommsAttachment; url: (token: string) => string; load?: (token: string) => Promise<string> }) {
  const [error, setError] = useState<string | null>(null);
  const full = a.mediaToken ? url(a.mediaToken) : null;
  const thumb = a.thumbToken ? url(a.thumbToken) : full;
  const ratio = a.w && a.h ? { aspectRatio: `${a.w} / ${a.h}` } : undefined;
  if ((a.kind === "image" || a.kind === "sticker") && thumb)
    return <img className="prism-comms-media" data-kind={a.kind} src={thumb} alt={a.name || (a.kind === "sticker" ? "Sticker" : "Photo")} loading="lazy" style={ratio} />;
  if ((a.kind === "video" || a.kind === "audio" || a.kind === "voice") && a.mediaToken && load)
    return <LazyPlayer a={a} load={load} thumb={a.kind === "video" && a.thumbToken ? url(a.thumbToken) : null} />;
  if (a.kind === "video" && full)
    return <video className="prism-comms-media" controls preload="none" poster={thumb ?? undefined} src={full} style={ratio} aria-label={a.name || "Video"} />;
  if ((a.kind === "audio" || a.kind === "voice") && full)
    return (
      <span className="prism-comms-audio">
        <span className="prism-comms-attachment-label">{a.kind === "voice" ? "Voice message" : a.name || "Audio"}{a.durationMs ? ` · ${duration(a.durationMs)}` : ""}</span>
        <audio controls preload="none" src={full} aria-label={a.kind === "voice" ? "Voice message" : a.name || "Audio"} />
      </span>
    );
  if (a.kind === "location")
    return <span className="prism-comms-file"><MapPin size={16} aria-hidden="true" /><span>{a.name || "Location"}{a.geo ? ` · ${a.geo.replace(/^geo:/, "")}` : ""}</span></span>;
  return (
    <span className="prism-comms-file">
      <FileText size={16} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate">{a.name || "File"}</span>
        <span className="prism-comms-attachment-label">{[a.mime, bytes(a.size)].filter(Boolean).join(" · ")}</span>
      </span>
      {full && (
        <button
          type="button"
          className="prism-comms-file-action focus-ring"
          onClick={() => {
            setError(null);
            void serverFetch(full).then(async (r) => {
              if (!r.ok) throw new Error(String(r.status));
              downloadBlob(a.name || "download", await r.blob());
            }).catch(() => setError("Couldn’t download this file."));
          }}
        >
          Download
        </button>
      )}
      {error && <span role="alert" className="prism-comms-attachment-label">{error}</span>}
    </span>
  );
}

// ── transcript ───────────────────────────────────────────────────────────────

const validTime = (t: number) => t > 0 && Number.isFinite(t);
const dayLabel = (t: number) => (validTime(t) ? fmtDate(t, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Date unavailable");
const timeLabel = (t: number) => (validTime(t) ? fmtTime(t, { hour: "numeric", minute: "2-digit" }) : "");

export interface CommsTranscriptProps {
  thread: Pick<CommsThread, "id" | "kind" | "title">;
  scope: string | null;
  /** A sender with a person note was clicked (group bylines). */
  onOpenPerson?: (personId: string, name: string) => void;
  /** Shown under the last loaded message when the API has no older page (archived ranges). */
  archive?: ReactNode;
}

export function CommsTranscript({ thread, scope, onOpenPerson, archive }: CommsTranscriptProps) {
  const vault = useVaultClient();
  const comms = vault.comms!;
  // Older pages are read once each, on "Load earlier" — never re-polled (each is a Matrix read).
  const query = useInfiniteQuery({
    queryKey: commsMessagesKey(scope, thread.id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => comms.getMessages(thread.id, pageParam),
    getNextPageParam: (last, pages) => (pages.length < MAX_PAGES && last.hasMore && last.before ? last.before : undefined),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // Freshness: the newest page alone, polled (paused while hidden, backing off after failures).
  const base = useLivePollMs(15_000);
  const head = useQuery({
    queryKey: commsHeadKey(scope, thread.id),
    queryFn: () => comms.getMessages(thread.id),
    enabled: query.isSuccess,
    retry: false,
    refetchInterval: (q) => backoff(base, q.state.fetchFailureCount),
    refetchIntervalInBackground: false,
  });
  // Pages come newest first; each page is oldest-first. One list, oldest first, no duplicate ids;
  // the polled newest page wins for a message it also holds (reactions, edits, delivery).
  const messages = useMemo(() => {
    const latest = new Map((head.data?.messages ?? []).map((m) => [m.id, m]));
    const seen = new Set<string>();
    const out: CommsMessage[] = [];
    for (const page of [...(query.data?.pages ?? [])].reverse())
      for (const m of page.messages) if (!seen.has(m.id)) { seen.add(m.id); out.push(latest.get(m.id) ?? m); }
    for (const m of head.data?.messages ?? []) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    return out;
  }, [query.data, head.data]);
  const runs = useMemo(() => groupRuns(messages), [messages]);
  const containerRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => messages.map((m) => ({ event_id: m.id })), [messages]);
  const reading = useThreadReadingPosition(containerRef, ids);
  const url = comms.mediaUrl;
  const group = thread.kind === "group";
  const atStart = !!query.data && !query.hasNextPage;

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={containerRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        className="workspace-message-thread prism-thread-content prism-comms-transcript flex-1 min-h-0 overflow-auto"
        style={{ overflowAnchor: "none" }}
        onScroll={reading.onScroll}
        onWheel={reading.userIntent}
        onTouchMove={reading.userIntent}
        onKeyDown={(e) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) reading.userIntent(); }}
      >
        {query.hasNextPage && (
          <button type="button" className="prism-earlier-messages block mx-auto text-xs" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
        )}
        {atStart && archive}
        {query.isPending && <p role="status" className="prism-comms-note">Loading messages…</p>}
        {query.isError && (
          <div role="alert" className="prism-comms-note">
            Messages couldn’t be loaded from the server.{" "}
            <button type="button" className="underline focus-ring" onClick={() => void query.refetch()}>Try again</button>
          </div>
        )}
        {query.isSuccess && messages.length === 0 && <p className="prism-comms-note">No messages to display yet.</p>}
        {runs.map((run) => (
          <Fragment key={run.key}>
            {run.newDay && (
              <div role="separator" aria-label={dayLabel(sentAtMs(run.messages[0]!))} className="prism-day-separator">
                <span>{dayLabel(sentAtMs(run.messages[0]!))}</span>
              </div>
            )}
            {run.afterGap && <div className="prism-comms-time-header">{timeLabel(sentAtMs(run.messages[0]!))}</div>}
            <Run run={run} group={group} url={url} load={comms.loadMedia} onOpenPerson={onOpenPerson} />
          </Fragment>
        ))}
      </div>
      {query.data?.pages.length === MAX_PAGES && query.data.pages.at(-1)?.hasMore && (
        <p className="prism-comms-note">Showing the latest {MAX_PAGES * 50} messages.</p>
      )}
      {reading.newMessages && (
        <button type="button" onClick={reading.jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-md" style={{ background: "var(--action-bg)", color: "var(--action-fg)" }}>
          New messages ↓
        </button>
      )}
    </div>
  );
}

function Run({ run, group, url, load, onOpenPerson }: { run: MessageRun; group: boolean; url: (t: string) => string; load?: (t: string) => Promise<string>; onOpenPerson?: CommsTranscriptProps["onOpenPerson"] }) {
  const first = run.messages[0]!;
  if (first.system) {
    return (
      <div className="prism-comms-system" data-message-id={first.id} data-kind={first.system.kind}>
        {first.system.text}
      </div>
    );
  }
  const outgoing = run.isSelf;
  const name = first.sender.name?.trim() || "Unknown sender";
  const t = sentAtMs(first);
  const personId = first.sender.personId;
  return (
    <article
      className={`prism-message-group prism-comms-run flex ${outgoing ? "prism-message-outgoing flex-row-reverse" : ""}`}
      data-outgoing={outgoing || undefined}
      aria-label={`Messages from ${outgoing ? "You" : name}`}
    >
      {!outgoing && <CommsAvatar avatar={first.sender.avatar} name={name} identity={first.sender.id || name} />}
      <div className={`min-w-0 flex-1 flex flex-col ${outgoing ? "items-end" : "items-start"}`}>
        <div className="prism-message-byline flex flex-wrap items-baseline gap-x-2 gap-y-1 max-w-full">
          {outgoing ? (
            <span className="prism-sender font-semibold">You</span>
          ) : group && personId && onOpenPerson ? (
            <button type="button" className="prism-sender prism-comms-sender-link font-semibold focus-ring" style={{ "--sender-tone": messageColor(first.sender.id || name) } as CSSProperties} onClick={() => onOpenPerson(personId, name)}>
              {name}
            </button>
          ) : (
            <span className="prism-sender font-semibold" style={{ "--sender-tone": messageColor(first.sender.id || name) } as CSSProperties}>{name}</span>
          )}
          {first.sender.isOmni && <span className="prism-comms-omni">Omni</span>}
          <time dateTime={validTime(t) ? new Date(t).toISOString() : undefined} title={validTime(t) ? fmtDateTime(new Date(t)) : undefined} style={{ color: "var(--text-muted)" }}>
            {timeLabel(t) || "Time unavailable"}
          </time>
        </div>
        {run.messages.map((m, i) => (
          <Bubble key={m.id} m={m} tail={i === run.messages.length - 1} url={url} load={load} />
        ))}
      </div>
    </article>
  );
}

const DELIVERY: Record<string, string> = { pending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Not delivered" };

function Bubble({ m, tail, url, load }: { m: CommsMessage; tail: boolean; url: (t: string) => string; load?: (t: string) => Promise<string> }) {
  const media = m.attachments.length > 0;
  const text = m.body?.plain.trim() ? m.body : null;
  return (
    <div className="prism-comms-message" data-message-id={m.id}>
      <div
        className="workspace-message-body prism-message-bubble prism-comms-bubble"
        data-tail={tail || undefined}
        data-jumbo={(text?.jumboEmoji && !media) || undefined}
        data-media-only={(media && !text && !m.replyTo) || undefined}
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {m.redacted ? (
          <span className="italic text-[var(--text-muted)]">Message removed</span>
        ) : (
          <>
            {m.replyTo && (
              <span className="prism-comms-reply" title={m.replyTo.snippet}>
                <Reply size={12} aria-hidden="true" />
                <span className="sr-only">In reply to </span>
                <span className="font-semibold">{m.replyTo.senderName}</span> <span className="truncate">{m.replyTo.snippet}</span>
              </span>
            )}
            {m.attachments.map((a, i) => <AttachmentView key={i} a={a} url={url} load={load} />)}
            {text && <span className="prism-comms-text"><Spans spans={text.spans} /></span>}
            {m.body?.truncated && <span className="block text-xs mt-1">This message is too long to display in full.</span>}
            {m.linkPreviews.map((p) => (
              <a key={p.url} className="prism-comms-preview focus-ring" href={/^https?:/i.test(p.url) ? p.url : undefined} target="_blank" rel="noopener noreferrer">
                {p.imageToken && <img src={url(p.imageToken)} alt="" loading="lazy" />}
                <span className="min-w-0">
                  <span className="prism-comms-preview-title">{p.title || p.url}</span>
                  {p.description && <span className="prism-comms-preview-desc">{p.description}</span>}
                  <span className="prism-comms-attachment-label">{p.siteName || safeHost(p.url)}</span>
                </span>
              </a>
            ))}
            {m.editedAt && <span className="prism-comms-edited">Edited</span>}
          </>
        )}
      </div>
      {m.reactions.length > 0 && (
        <ul className="prism-comms-reactions" aria-label="Reactions">
          {m.reactions.map((r) => (
            <li
              key={r.key}
              className="prism-comms-reaction"
              data-mine={r.mine || undefined}
              title={r.senders.map((s) => s.name).join(", ")}
              aria-label={`${r.key} ${r.count}${r.mine ? ", including you" : ""}${r.senders.length ? `: ${r.senders.map((s) => s.name).join(", ")}` : ""}`}
            >
              <span aria-hidden="true">{r.key}</span>
              {r.count > 1 && <span aria-hidden="true" className="prism-triage-count">{r.count}</span>}
            </li>
          ))}
        </ul>
      )}
      {m.sender.isSelf && m.delivery && m.delivery !== "sent" && tail && (
        <span className="prism-comms-delivery" data-state={m.delivery}>{DELIVERY[m.delivery]}</span>
      )}
    </div>
  );
}

function safeHost(u: string): string {
  try { return new URL(u).host; } catch { return ""; }
}
