import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { Bell, CalendarDays, FileText, Lock, Trash2, User } from "lucide-react";
import { setMentionNodeView, type MentionAttrs } from "./MentionNode";
import { formatChipDate, formatChipDateLong, isDateOnly, chipDate, ymd, localIso } from "./MentionDates";
import { mentionNoteId } from "./MentionContext";
import { mentionToast } from "./MentionToast";
import { queryKeys } from "../parachute/queries";
import { useUIStore } from "../../app/stores/ui";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable } from "../../data/VaultClient";
import { isTrashed } from "../pages/model";
import { noteLinkTitle } from "../wikilinks";
import { inferContentType } from "../schemas/content-types";
import { notificationsApi, localTimeZone } from "../notifications/client";
import type { ContentType } from "../types";
import "./mention.css";

/**
 * Interactive mention chips (NP-RF-03/04/05/06). Installed once per page load
 * through `setMentionNodeView`, so every editor that has the shared `mention`
 * node (plain and live) renders them. The wrapper carries `data-type`,
 * `data-kind`, `data-mention-uid` and `data-reminder` so notifications can deep
 * link to a chip.
 */

const HOVER_DELAY = 350;

/** Hover/focus-triggered floating card anchored to the chip. */
function useHover() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { open, setOpen, handlers: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide } };
}

/** A body-portaled panel placed under (or above) `anchor`, clamped to the viewport. */
function Floating({ anchor, children, label, role = "tooltip", onMouseEnter, onMouseLeave, className = "" }: {
  anchor: HTMLElement | null;
  children: ReactNode;
  label: string;
  role?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={`prism-mention-card glass-elevated ${className}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

function plainPreview(html: string | null | undefined): string {
  if (!html) return "";
  try {
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    return text.replace(/\s+/g, " ").trim().slice(0, 180);
  } catch {
    return "";
  }
}

function PageChip({ id, chip }: { id: string | null; chip: React.RefObject<HTMLSpanElement | null> }) {
  // The same query key as useNote (so renames/invalidations reach the chip), but
  // tolerant of surfaces with no VaultClient (public share page → "No access").
  const client = useOptionalVaultClient();
  const query = useQuery({
    queryKey: queryKeys.vault.note(id ?? ""),
    queryFn: () => client!.getNote(id!),
    enabled: !!id && !!client,
    retry: (count, error) => !isAccessUnavailable(error) && count < 1,
  });
  const note = { data: isAccessUnavailable(query.error) ? undefined : query.data, error: client ? query.error : new Error("no client") };
  const openTab = useUIStore((s) => s.openTab);
  const hover = useHover();
  const data = note.data && note.data.id === id ? note.data : undefined;
  const state = !id || !client ? "missing" : data ? (isTrashed(data) ? "deleted" : "ready") : note.error ? (isAccessUnavailable(note.error) ? "missing" : "error") : "loading";
  const title = state === "ready" ? noteLinkTitle(data!) : state === "deleted" ? "Deleted page" : state === "missing" ? "No access" : state === "error" ? "Page unavailable" : "Loading page…";
  const icon = state === "ready" && typeof data!.metadata?.icon === "string" ? (data!.metadata.icon as string) : null;
  const open = () => {
    if (state !== "ready") return;
    openTab(data!.id, noteLinkTitle(data!), inferContentType(data!));
  };
  return (
    <>
      <span
        ref={chip}
        className="prism-mention-chip"
        data-state={state}
        role="link"
        aria-disabled={state !== "ready" || undefined}
        aria-label={state === "ready" ? `Page: ${title}` : title}
        title={state === "missing" ? "You don’t have access to this page" : undefined}
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(); } }}
        {...hover.handlers}
      >
        <span className="prism-mention-icon" aria-hidden="true">
          {icon ? icon : state === "missing" ? <Lock size={12} /> : state === "deleted" ? <Trash2 size={12} /> : <FileText size={13} />}
        </span>
        <span className="prism-mention-text">{title}</span>
      </span>
      {hover.open && state === "ready" && (
        <Floating anchor={chip.current} label={`Preview of ${title}`} onMouseEnter={() => hover.setOpen(true)} onMouseLeave={hover.handlers.onMouseLeave}>
          <div className="prism-mention-card-title">{icon && <span aria-hidden="true">{icon} </span>}{title}</div>
          {data!.path && <div className="prism-mention-card-detail">{data!.path}</div>}
          {plainPreview(data!.content) && <p className="prism-mention-card-body">{plainPreview(data!.content)}</p>}
        </Floating>
      )}
    </>
  );
}

function PersonChip({ id, label, chip }: { id: string | null; label: string; chip: React.RefObject<HTMLSpanElement | null> }) {
  const client = useOptionalVaultClient();
  const openTab = useUIStore((s) => s.openTab);
  const hover = useHover();
  const person = useQuery({
    queryKey: ["vault", "person", "mention-card", id],
    queryFn: () => client!.getPerson!(id!),
    enabled: hover.open && !!id && !!client?.getPerson,
    staleTime: 60_000,
    retry: false,
  });
  const name = person.data?.person.name ?? label;
  const open = () => {
    if (id) openTab(`people:${id}`, name, "people" as ContentType);
  };
  return (
    <>
      <span
        ref={chip}
        className="prism-mention-chip"
        data-state="ready"
        role="link"
        aria-label={`Person: ${name}`}
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(); } }}
        {...hover.handlers}
      >
        <span className="prism-mention-at" aria-hidden="true">@</span>
        <span className="prism-mention-text">{label}</span>
      </span>
      {hover.open && (
        <Floating anchor={chip.current} label={`About ${name}`} onMouseEnter={() => hover.setOpen(true)} onMouseLeave={hover.handlers.onMouseLeave}>
          <div className="prism-mention-card-head">
            <span className="prism-mention-avatar" aria-hidden="true">{name.charAt(0).toUpperCase() || <User size={14} />}</span>
            <div>
              <div className="prism-mention-card-title">{name}</div>
              {person.data?.person.role && <div className="prism-mention-card-detail">{person.data.person.role}</div>}
            </div>
          </div>
          {person.isError ? (
            <p className="prism-mention-card-body">Profile unavailable.</p>
          ) : person.data ? (
            person.data.person.identities.length ? (
              <ul className="prism-mention-identities" aria-label="Linked identities">
                {person.data.person.identities.slice(0, 5).map((i) => (
                  <li key={`${i.kind}:${i.value}`}><span>{i.kind}</span>{i.value}</li>
                ))}
              </ul>
            ) : (
              <p className="prism-mention-card-body">No linked identities.</p>
            )
          ) : (
            <p className="prism-mention-card-body" role="status">Loading profile…</p>
          )}
          <button type="button" className="prism-mention-card-action focus-ring" onClick={open}>Open profile</button>
        </Floating>
      )}
    </>
  );
}

/** Date + time + reminder editor for a date chip. */
function DatePopover({ anchor, attrs, editable, onSave, onClose, noteId }: {
  anchor: HTMLElement | null;
  attrs: MentionAttrs;
  editable: boolean;
  noteId: string | null;
  onSave: (next: Partial<MentionAttrs>) => void;
  onClose: () => void;
}) {
  const current = chipDate(attrs.date) ?? new Date();
  const [day, setDay] = useState(ymd(current));
  const [time, setTime] = useState(isDateOnly(attrs.date) || !attrs.date ? "" : `${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`);
  const [remind, setRemind] = useState(!!attrs.reminder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor?.contains(t) || document.querySelector(".prism-mention-date-editor")?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [anchor, onClose]);
  const save = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { setError("Choose a date."); return; }
    const [y, m, d] = day.split("-").map(Number);
    let value = day;
    if (time) {
      const [h, min] = time.split(":").map(Number);
      value = localIso(new Date(y!, m! - 1, d!, h!, min!));
    }
    const dateOnly = !time;
    let reminder = attrs.reminder;
    setBusy(true);
    setError("");
    try {
      if (remind && noteId) {
        const body = { at: value, tz: localTimeZone(), dateOnly };
        reminder = reminder
          ? (await notificationsApi.updateReminder(reminder, body)).reminder.id
          : (await notificationsApi.createReminder({ noteId, uid: attrs.uid, ...body })).reminder.id;
      } else if (!remind && reminder) {
        await notificationsApi.cancelReminder(reminder);
        reminder = null;
      }
    } catch {
      setBusy(false);
      setError(remind ? "The reminder couldn’t be saved. Try again." : "The reminder couldn’t be removed. Try again.");
      return;
    }
    setBusy(false);
    onSave({ date: value, reminder });
    if (remind && !attrs.reminder) mentionToast(`Reminder set for ${formatChipDate(value)}.`);
    onClose();
  };
  return (
    <Floating anchor={anchor} label="Edit date" role="dialog" className="prism-mention-date-editor">
      <div ref={panel} className="prism-mention-date-form">
        <div className="prism-mention-card-title">{formatChipDateLong(attrs.date)}</div>
        {editable ? (
          <>
            <label>Date<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
            <label>Time<input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-describedby="prism-mention-time-hint" /></label>
            <span id="prism-mention-time-hint" className="prism-mention-card-detail">Leave the time empty for an all-day date.</span>
            {noteId && (
              <label className="prism-mention-check">
                <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
                <Bell size={13} aria-hidden="true" /> Remind me
              </label>
            )}
            {error && <p role="alert" className="prism-mention-error">{error}</p>}
            <div className="prism-mention-actions">
              <button type="button" className="focus-ring" onClick={onClose}>Cancel</button>
              <button type="button" className="focus-ring prism-mention-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Done"}</button>
            </div>
          </>
        ) : (
          attrs.reminder && <p className="prism-mention-card-detail"><Bell size={12} aria-hidden="true" /> Reminder set</p>
        )}
      </div>
    </Floating>
  );
}

function DateChip({ props, chip }: { props: NodeViewProps; chip: React.RefObject<HTMLSpanElement | null> }) {
  const attrs = props.node.attrs as MentionAttrs;
  const [editing, setEditing] = useState(false);
  const editable = props.editor.isEditable;
  const label = formatChipDate(attrs.date);
  return (
    <>
      <span
        ref={chip}
        className="prism-mention-chip"
        data-state="ready"
        data-date-chip=""
        role="button"
        aria-haspopup="dialog"
        aria-expanded={editing}
        aria-label={`${formatChipDateLong(attrs.date)}${attrs.reminder ? ", reminder set" : ""}`}
        title={formatChipDateLong(attrs.date)}
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
      >
        <span className="prism-mention-icon" aria-hidden="true">{attrs.reminder ? <Bell size={12} /> : <CalendarDays size={12} />}</span>
        <span className="prism-mention-text">{label}</span>
      </span>
      {editing && (
        <DatePopover
          anchor={chip.current}
          attrs={attrs}
          editable={editable}
          noteId={mentionNoteId(props.editor)}
          onSave={(next) => props.updateAttributes(next)}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function MentionChip(props: NodeViewProps) {
  const attrs = props.node.attrs as MentionAttrs;
  const chip = useRef<HTMLSpanElement | null>(null);
  return (
    <NodeViewWrapper
      as="span"
      className="prism-mention"
      data-type="mention"
      data-kind={attrs.kind}
      data-mention-uid={attrs.uid ?? undefined}
      data-reminder={attrs.reminder ?? undefined}
      data-selected={props.selected || undefined}
      contentEditable={false}
    >
      {attrs.kind === "person" ? (
        <PersonChip id={attrs.id} label={attrs.label ?? "person"} chip={chip} />
      ) : attrs.kind === "date" ? (
        <DateChip props={props} chip={chip} />
      ) : (
        <PageChip id={attrs.id} chip={chip} />
      )}
    </NodeViewWrapper>
  );
}

setMentionNodeView(
  ReactNodeViewRenderer(MentionChip, {
    as: "span",
    className: "prism-mention-root",
    // Pointer interaction on a chip is the chip's (open / hover / date editor):
    // ProseMirror must not turn the click into a node selection (which would
    // also pop the formatting bubble). Keyboard selection is unchanged.
    stopEvent: ({ event }) => event.type === "mousedown",
  }),
);

/** Import for its side effect: installs the interactive chip. */
export const MENTION_VIEW_INSTALLED = true;
