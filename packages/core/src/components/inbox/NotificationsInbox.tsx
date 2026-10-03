import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Bell, Check, CheckCheck, Settings2, WifiOff, Inbox as InboxIcon } from "lucide-react";
import type { RendererProps } from "../renderers/RendererProps";
import { useArchive, useMarkRead, useNotifications, useOnline, isNotificationsUnavailable, announceNotificationsChanged } from "../../lib/notifications/hooks";
import { openNotification, takePendingNotification, clearPendingNotification } from "../../lib/notifications/anchor";
import { notificationsApi, type AccessLevel, type NotificationItem, type NotificationType } from "../../lib/notifications/client";
import { NotificationSettingsPanel } from "./NotificationSettingsPanel";
import { useSwipeActions } from "../../lib/gestures/useSwipeActions";
import "./inbox.css";

type Filter = "all" | "mentions" | "replies" | "reminders" | "requests";
const FILTERS: Array<{ id: Filter; label: string; types: NotificationType[] | null }> = [
  { id: "all", label: "All", types: null },
  { id: "mentions", label: "Mentions", types: ["mention", "comment_mention"] },
  { id: "replies", label: "Replies", types: ["comment_reply"] },
  { id: "reminders", label: "Reminders", types: ["reminder"] },
  { id: "requests", label: "Requests", types: ["access_request", "access_granted", "access_denied", "share"] },
];

const DAY = 86_400_000;
function groupOf(ts: number, now = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (ts >= start.getTime()) return "Today";
  if (ts >= start.getTime() - DAY) return "Yesterday";
  return "Earlier";
}
function timeLabel(ts: number): string {
  const d = new Date(ts);
  const g = groupOf(ts);
  if (g === "Earlier") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** One plain sentence per type. Names and titles are text nodes (never HTML). */
function sentence(n: NotificationItem): { who: string | null; text: string; page: string } {
  const who = n.actor?.name ?? null;
  const page = n.title ?? "a page";
  switch (n.type) {
    case "mention": return { who, text: "mentioned you in", page };
    case "comment_mention": return { who, text: "mentioned you in a comment on", page };
    case "comment_reply": return { who, text: "replied to your thread on", page };
    case "reminder": return { who: null, text: "Reminder:", page };
    case "share": return { who, text: "shared a page with you:", page };
    case "access_request": return { who, text: "requested access to", page };
    case "access_granted": return { who: null, text: "Your access request was approved:", page };
    case "access_denied": return { who: null, text: "Your access request was declined:", page };
    case "suggestion_accepted": return { who, text: "accepted your suggestion on", page };
    case "suggestion_rejected": return { who, text: "declined your suggestion on", page };
    case "suggestion_resolved": return { who, text: "resolved your suggestion on", page };
    default: return { who, text: "updated", page };
  }
}

/** Notion-style notifications inbox (NP-CO-03): Inbox / Archived, grouped, read state, deep links. */
export default function NotificationsInbox(_props: RendererProps) {
  const [box, setBox] = useState<"inbox" | "archived">("inbox");
  const [filter, setFilter] = useState<Filter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const online = useOnline();
  const list = useNotifications(box);
  const markRead = useMarkRead();
  const archive = useArchive();

  const all = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const unread = list.data?.pages[0]?.unread ?? 0;
  const types = FILTERS.find((f) => f.id === filter)!.types;
  const items = types ? all.filter((n) => types.includes(n.type)) : all;
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: NotificationItem[] }> = [];
    for (const n of items) {
      const label = groupOf(n.createdAt);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items]);

  const open = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    openNotification(n);
  };
  const unavailable = list.isError && isNotificationsUnavailable(list.error);

  // Push deep link (/inbox/<id>): open that notification once it is loaded.
  useEffect(() => {
    const pending = takePendingNotification();
    if (!pending || !list.data) return;
    const hit = all.find((n) => n.id === pending);
    if (hit) { clearPendingNotification(); open(hit); }
    else if (!list.hasNextPage) clearPendingNotification();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  return (
    <div className="prism-inbox" data-testid="notifications-inbox">
      <div className="prism-inbox-inner">
        <header className="prism-inbox-header">
          <h1>Inbox</h1>
          <div className="prism-inbox-actions">
            {box === "inbox" && (
              <button type="button" className="prism-inbox-btn" disabled={unread === 0 || markRead.isPending} onClick={() => markRead.mutate({ all: true })}>
                <CheckCheck size={15} /> <span>Mark all read</span>
              </button>
            )}
            <button type="button" className="prism-inbox-btn" aria-label="Notification settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
              <Settings2 size={15} />
            </button>
          </div>
        </header>

        {settingsOpen && <NotificationSettingsPanel onClose={() => setSettingsOpen(false)} />}

        <div className="prism-inbox-tabs" role="tablist" aria-label="Inbox folders">
          {(["inbox", "archived"] as const).map((b) => (
            <button key={b} type="button" role="tab" aria-selected={box === b} className="prism-inbox-tab focus-ring" onClick={() => setBox(b)}>
              {b === "inbox" ? `Inbox${unread ? ` · ${unread}` : ""}` : "Archived"}
            </button>
          ))}
        </div>
        <div className="prism-inbox-filters" role="group" aria-label="Filter notifications">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="prism-inbox-chip focus-ring" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>

        {!online && (
          <div role="status" className="prism-inbox-banner"><WifiOff size={14} /> You’re offline. Showing the notifications loaded last.</div>
        )}

        {list.isLoading ? (
          <p className="prism-inbox-empty">Loading notifications…</p>
        ) : unavailable ? (
          <div className="prism-inbox-empty"><Bell size={28} /><strong>Notifications aren’t available here</strong>Sign in to your Prism Server to see mentions, replies and reminders.</div>
        ) : list.isError && all.length === 0 ? (
          <div role="alert" className="prism-inbox-empty">
            <Bell size={28} /><strong>Couldn’t load your inbox</strong>Check your connection and try again.
            <div className="mt-4"><button type="button" className="prism-inbox-btn" data-variant="outline" onClick={() => void list.refetch()}>Retry</button></div>
          </div>
        ) : items.length === 0 ? (
          <div className="prism-inbox-empty" data-testid="inbox-empty">
            <InboxIcon size={28} />
            <strong>{box === "archived" ? "Nothing archived" : filter === "all" ? "You’re all caught up" : "Nothing here"}</strong>
            {box === "inbox" ? "Mentions, replies, reminders and access requests show up here." : "Archived notifications stay here for reference."}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="prism-inbox-group" aria-label={g.label}>
              <h2>{g.label}</h2>
              <ul className="list-none p-0 m-0" style={{ overflowX: "clip" }}>
                {g.items.map((n) => (
                  <NotificationRow key={n.id} n={n} box={box} onOpen={() => open(n)}
                    onRead={() => markRead.mutate({ ids: [n.id] })}
                    onArchive={() => archive.mutate({ ids: [n.id], archived: box === "inbox" })} />
                ))}
              </ul>
            </section>
          ))
        )}
        {list.hasNextPage && (
          <div className="mt-4 text-center">
            <button type="button" className="prism-inbox-btn" data-variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function initials(name: string | null): string {
  if (!name) return "•";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

function NotificationRow({ n, box, onOpen, onRead, onArchive }: {
  n: NotificationItem; box: "inbox" | "archived"; onOpen: () => void; onRead: () => void; onArchive: () => void;
}) {
  const s = sentence(n);
  const canOpen = !!n.noteId;
  // Phone (touch): swipe left to archive / restore, right to mark read. The row's
  // buttons below do the same for keyboard, mouse and screen readers.
  const swipe = useSwipeActions<HTMLLIElement>({
    left: { label: box === "inbox" ? "Archive" : "Move to Inbox", run: onArchive },
    right: n.readAt ? null : { label: "Mark as read", run: onRead, tone: "accent" },
  });
  return (
    <li ref={swipe.ref} className="prism-inbox-row prism-swipe-row" data-unread={!n.readAt} data-testid="notification-row" data-type={n.type}>
      {swipe.hint}
      <span className="prism-inbox-avatar" aria-hidden>{n.type === "reminder" ? <Bell size={14} /> : initials(s.who)}</span>
      <div className="flex-1 min-w-0">
        <button type="button" className="prism-inbox-open focus-ring" onClick={onOpen} disabled={!canOpen}
          aria-label={`${s.who ? `${s.who} ` : ""}${s.text} ${s.page}${n.readAt ? "" : ", unread"}`}>
          <div className="prism-inbox-line">
            {s.who && <strong>{s.who} </strong>}{s.text} <strong>{s.page}</strong>
          </div>
          {n.preview && <div className="prism-inbox-preview">{n.preview}</div>}
          <div className="prism-inbox-meta">{timeLabel(n.createdAt)}</div>
        </button>
        {n.type === "access_request" && n.requestId && <AccessDecision requestId={n.requestId} onDone={onRead} />}
      </div>
      <div className="prism-inbox-row-actions">
        {!n.readAt && (
          <button type="button" className="prism-inbox-icon-btn focus-ring" aria-label="Mark as read" title="Mark as read" onClick={onRead}><Check size={15} /></button>
        )}
        <button type="button" className="prism-inbox-icon-btn focus-ring" aria-label={box === "inbox" ? "Archive" : "Move to Inbox"} title={box === "inbox" ? "Archive" : "Move to Inbox"} onClick={onArchive}>
          {box === "inbox" ? <Archive size={15} /> : <ArchiveRestore size={15} />}
        </button>
      </div>
    </li>
  );
}

const LEVELS: Array<{ id: AccessLevel; label: string }> = [
  { id: "view", label: "Can view" },
  { id: "comment", label: "Can comment" },
  { id: "suggest", label: "Can suggest" },
  { id: "edit", label: "Can edit" },
];

/** Approve (with a level) or deny an access request, inline in its notification. */
function AccessDecision({ requestId, onDone }: { requestId: string; onDone: () => void }) {
  const [level, setLevel] = useState<AccessLevel>("view");
  const [state, setState] = useState<"idle" | "busy" | "approved" | "denied" | "error" | "gone">("idle");
  const decide = async (decision: "approve" | "deny") => {
    setState("busy");
    try {
      const r = await notificationsApi.decideAccessRequest(requestId, decision, decision === "approve" ? level : undefined);
      setState(r.status === "approved" ? "approved" : "denied");
      onDone();
      announceNotificationsChanged();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 404 || status === 409 ? "gone" : "error");
    }
  };
  if (state === "approved") return <p role="status" className="prism-inbox-meta" data-testid="access-decided">Approved · {LEVELS.find((l) => l.id === level)?.label.toLowerCase()}</p>;
  if (state === "denied") return <p role="status" className="prism-inbox-meta" data-testid="access-decided">Declined</p>;
  if (state === "gone") return <p role="status" className="prism-inbox-meta">This request was already handled.</p>;
  return (
    <div className="prism-inbox-decide" data-testid="access-decision">
      <select className="prism-inbox-select" aria-label="Access level" value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)}>
        {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      <button type="button" className="prism-inbox-btn" data-variant="primary" disabled={state === "busy"} onClick={() => void decide("approve")}>Approve</button>
      <button type="button" className="prism-inbox-btn" data-variant="outline" disabled={state === "busy"} onClick={() => void decide("deny")}>Deny</button>
      {state === "error" && <span role="alert" className="text-xs text-[var(--color-danger)]">Couldn’t record the decision. Try again.</span>}
    </div>
  );
}
