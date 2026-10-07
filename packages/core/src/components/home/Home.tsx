import { isTemplateNote } from "../../lib/pages/model";
import { useMemo } from "react";
import { dueSortKey } from "../../lib/database/dates";
import { useQuery } from "@tanstack/react-query";
import { AtSign, Bell, CalendarDays, CheckSquare, Clock, FileText, Inbox, LayoutTemplate, Plus } from "lucide-react";
import type { RendererProps } from "../renderers/RendererProps";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../../lib/parachute/queries";
import { useVaultClient } from "../../data/VaultClientContext";
import { usePagesUI } from "../../lib/pages/store";
import { calendarApi, type CalendarEvent } from "../../lib/sync/client";
import { useNotifications, useReminders, useUnreadCount } from "../../lib/notifications/hooks";
import { openNotification } from "../../lib/notifications/anchor";
import { openInbox } from "../inbox/InboxNavButton";
import { noteLinkTitle } from "../../lib/wikilinks";
import type { ContentType, Note } from "../../lib/types";
import "../inbox/inbox.css";

import { formatDate as fmtDate, formatTime as fmtTime } from "../../lib/datetime/format";
const DONE = new Set(["done", "complete", "completed", "cancelled", "canceled", "archived", "closed"]);

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const time = fmtTime(d, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${fmtDate(d, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}
function eventStart(e: CalendarEvent): number {
  return Date.parse(e.start.dateTime ?? e.start.date ?? "");
}

/**
 * Home (NP-SB-03): recently visited pages, upcoming reminders + calendar events,
 * open tasks, unread updates and mentions of you, quick create. Every list reads
 * through the same seams as the rest of the app (VaultClient, notifications
 * client), so it shows only what the viewer may see.
 */
export default function Home(_props: RendererProps) {
  const openTab = useUIStore((s) => s.openTab);
  const { recents } = useNoteShortcuts();
  const client = useVaultClient();
  const now = useMemo(() => Date.now(), []);
  const reminders = useReminders();
  const events = useQuery({
    queryKey: ["home", "events", new Date(now).toDateString()],
    queryFn: () => calendarApi.listEventsFromVault(new Date(now).toISOString(), new Date(now + 7 * 86_400_000).toISOString(), client),
    retry: false,
    staleTime: 60_000,
  });
  // My tasks (wave 3): the tasks ASSIGNED TO THE VIEWER, resolved by the server
  // (`/api/query {assignedToMe}` — the viewer's person page / addresses). A shell
  // or server without that (desktop, older server: no `identity` in the answer)
  // keeps the previous list of every open task the viewer can see.
  const assigned = useQuery({
    queryKey: ["vault", "notes", { tag: "task", assignedToMe: true }],
    queryFn: () => client.queryNotes!({ tags: ["task"], assignedToMe: true, limit: 200, fields: ["status", "due", "due_date", "dueDate", "type"] }),
    enabled: !!client.queryNotes,
    retry: false,
    staleTime: 30_000,
  });
  // The server owner with no owner identity set gets every task back, plus a hint.
  const ownerUnset = assigned.data?.identity === "unset";
  const scoped = !!client.queryNotes && !assigned.isError && (assigned.isLoading || assigned.data?.identity !== undefined);
  // The broad listing runs only when the scoped query is not available.
  const allTasks = useQuery({
    queryKey: queryKeys.vault.notes({ tag: "task", limit: 300 }),
    queryFn: () => client.listNotes({ tag: "task", limit: 300 }),
    select: (list: Note[]) => list.filter((n) => !(n.tags ?? []).includes("prism-trashed") && !isTemplateNote(n)),
    enabled: !scoped,
  });
  const tasks = scoped
    ? { isLoading: assigned.isLoading, data: (assigned.data?.rows ?? []).map((r) => ({ id: r.id, path: r.path, tags: r.tags, metadata: r.metadata, content: "", createdAt: r.createdAt, updatedAt: r.updatedAt }) as unknown as Note) }
    : { isLoading: allTasks.isLoading, data: allTasks.data };
  const unread = useUnreadCount();
  const mentions = useNotifications("inbox", "mention");

  const upcoming = useMemo(() => {
    const rows: Array<{ key: string; at: number; label: string; kind: "reminder" | "event"; open: () => void }> = [];
    for (const r of reminders.data?.items ?? []) {
      if (r.status !== "scheduled" || r.at < now - 60_000) continue;
      rows.push({ key: `r-${r.id}`, at: r.at, label: r.title ?? "Reminder", kind: "reminder",
        open: () => openNotification({ id: r.id, type: "reminder", noteId: r.noteId, title: r.title, actor: null, anchor: r.uid ? { mention: r.uid } : { reminder: r.id }, preview: null, createdAt: r.at, readAt: 1, archivedAt: null }) });
    }
    for (const e of Array.isArray(events.data) ? events.data : []) {
      const at = eventStart(e);
      if (!Number.isFinite(at) || at < now - 3_600_000) continue;
      rows.push({ key: `e-${e.id}`, at, label: e.summary, kind: "event",
        open: () => e.vaultNoteId ? openTab(e.vaultNoteId, e.summary, "event" as ContentType) : openTab("calendar-dashboard", "Calendar", "calendar-dashboard" as ContentType) });
    }
    return rows.sort((a, b) => a.at - b.at).slice(0, 8);
  }, [reminders.data, events.data, now, openTab]);

  const openTasks = useMemo(() => {
    const list = (tasks.data ?? []).filter((n: Note) => !DONE.has(String(n.metadata?.status ?? "").toLowerCase()));
    // A due date may be a day, a time or a range (start/end): order by its start.
    const due = (n: Note) => dueSortKey(n.metadata?.due ?? n.metadata?.due_date ?? n.metadata?.dueDate);
    return list.sort((a, b) => due(a) - due(b)).slice(0, 8);
  }, [tasks.data]);

  const mentionItems = (mentions.data?.pages[0]?.items ?? []).slice(0, 5);

  return (
    <div className="prism-home" data-testid="home">
      <div className="prism-home-inner">
        <h1>{greeting()}</h1>
        <p className="prism-home-sub">Pick up where you left off.</p>
        <div className="prism-home-create">
          <button type="button" className="prism-inbox-btn" data-variant="primary" onClick={() => usePagesUI.getState().openCreate({})}><Plus size={15} /> New page</button>
          <button type="button" className="prism-inbox-btn" data-variant="outline" onClick={() => usePagesUI.getState().openCreate({ template: true })}><LayoutTemplate size={15} /> From template</button>
          {unread.available && (
            <button type="button" className="prism-inbox-btn" data-variant="outline" onClick={openInbox}>
              <Inbox size={15} /> Inbox{unread.count > 0 ? ` · ${unread.count} unread` : ""}
            </button>
          )}
        </div>

        <section className="prism-home-section" aria-label="Recently visited">
          <h2><Clock size={14} /> Recently visited</h2>
          {recents.length === 0 ? (
            <p className="prism-home-muted">Pages you open will appear here.</p>
          ) : (
            <div className="prism-home-recents">
              {recents.slice(0, 8).map((r) => (
                <button key={r.id} type="button" className="prism-home-card focus-ring" onClick={() => openTab(r.id, r.title, r.type)}>
                  <FileText size={18} color="var(--text-muted)" />
                  <span>{r.title}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="prism-home-grid">
          <section className="prism-home-panel" aria-label="Upcoming">
            <h2><CalendarDays size={14} /> Upcoming</h2>
            {upcoming.length === 0 ? (
              <p className="prism-home-muted">{events.isError && reminders.isError ? "Calendar and reminders aren’t available right now." : "Nothing scheduled in the next week."}</p>
            ) : upcoming.map((u) => (
              <button key={u.key} type="button" className="prism-home-item focus-ring" onClick={u.open} data-kind={u.kind}>
                {u.kind === "reminder" ? <Bell size={14} color="var(--color-accent)" /> : <CalendarDays size={14} color="var(--text-muted)" />}
                <span className="label">{u.label}</span>
                <span className="when">{when(u.at)}</span>
              </button>
            ))}
          </section>

          <section className="prism-home-panel" aria-label="My tasks" data-scope={scoped && !ownerUnset ? "assigned" : "all"}>
            <h2><CheckSquare size={14} /> My tasks</h2>
            {ownerUnset && <p className="prism-home-muted" data-testid="my-tasks-hint">Showing every open task. Set the owner identity (your person page) to see only the ones assigned to you.</p>}
            {tasks.isLoading ? <p className="prism-home-muted">Loading tasks…</p>
              : openTasks.length === 0 ? <p className="prism-home-muted">{scoped && !ownerUnset
                ? assigned.data?.identity === "account" ? "No open tasks assigned to you. Tasks assigned by name appear once a person page carries your sign-in email." : "No open tasks assigned to you."
                : "No open tasks."}</p>
              : openTasks.map((t) => (
                <button key={t.id} type="button" className="prism-home-item focus-ring" onClick={() => openTab(t.id, noteLinkTitle(t), "task")}>
                  <CheckSquare size={14} color="var(--text-muted)" />
                  <span className="label">{noteLinkTitle(t)}</span>
                  {typeof t.metadata?.status === "string" && <span className="when">{t.metadata.status}</span>}
                </button>
              ))}
          </section>

          {unread.available && (
            <section className="prism-home-panel" aria-label="Mentions of you" style={{ gridColumn: "1 / -1" }}>
              <h2><AtSign size={14} /> Mentions of you</h2>
              {mentionItems.length === 0 ? <p className="prism-home-muted">No mentions yet.</p>
                : mentionItems.map((n) => (
                  <button key={n.id} type="button" className="prism-home-item focus-ring" onClick={() => openNotification(n)} data-unread={!n.readAt}>
                    <AtSign size={14} color={n.readAt ? "var(--text-muted)" : "var(--color-accent)"} />
                    <span className="label">{n.actor?.name ? `${n.actor.name} · ` : ""}{n.title ?? "a page"}</span>
                    <span className="when">{fmtDate(new Date(n.createdAt), { month: "short", day: "numeric" })}</span>
                  </button>
                ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
