import { useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { Bell, BellOff, BellRing, Check } from "lucide-react";
import { usePageNotificationLevel } from "../../lib/notifications/hooks";
import { PAGE_NOTIFICATION_LEVELS, type PageNotificationLevel } from "../../lib/notifications/client";
import { useUIStore } from "../../app/stores/ui";
import { isVaultNoteId } from "../../lib/noteIdentity";

export const pageLevelIcon = (level: PageNotificationLevel | null, size = 15) =>
  level === "none" ? <BellOff size={size} /> : level === "all" ? <BellRing size={size} /> : <Bell size={size} />;
export const pageLevelLabel = (level: PageNotificationLevel | null) =>
  PAGE_NOTIFICATION_LEVELS.find((l) => l.id === level)?.label ?? "Replies and @mentions";

/**
 * Which page a comments sidebar belongs to, when its host did not say: the page
 * in front inside the workspace, or the share route's own address (/collab/<id>).
 * A row peek shows another page than the one in front, so it answers null there
 * (the control hides rather than set a level on the wrong page).
 */
function pageAround(el: HTMLElement | null, activeNoteId: string | undefined): string | null {
  if (!el || el.closest(".db-peek")) return null;
  if (el.closest("#workspace-document")) return isVaultNoteId(activeNoteId) ? activeNoteId : null;
  const m = /^\/collab\/([^/?#]+)/.exec(window.location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Per-page notification level (NP-CO-04): a small button that says the current
 * level and opens the three choices. Renders nothing where the viewer has no
 * inbox — a share-link guest, an older server, the desktop shell, or a host with
 * no data context.
 */
export function PageNotificationLevelButton(props: { noteId?: string | null }) {
  const queries = useContext(QueryClientContext);
  return queries ? <LevelButton {...props} /> : null;
}

function LevelButton({ noteId: given }: { noteId?: string | null }) {
  const probe = useRef<HTMLSpanElement>(null);
  const activeNoteId = useUIStore((s) => s.openTabs.find((t) => t.id === s.activeTabId)?.noteId);
  const [found, setFound] = useState<string | null>(null);
  useEffect(() => {
    if (!given) setFound(pageAround(probe.current, activeNoteId));
  }, [given, activeNoteId]);
  const noteId = given ?? found;
  const q = usePageNotificationLevel(noteId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const down = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  const ready = !!noteId && q.available;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  // The wrapper is always mounted (it is how the page is found); its content only when there is a level to show.
  return (
    <span ref={probe} className="prism-page-level" hidden={!ready} data-testid={ready ? "page-notification-level" : undefined} data-level={ready ? q.level ?? "" : undefined}>
      {ready && (
        <span ref={root} style={{ display: "contents" }}>
          <button ref={trigger} type="button" className="prism-page-level-btn focus-ring" aria-haspopup="menu" aria-expanded={open}
            aria-label={`Notifications for this page: ${pageLevelLabel(q.level)}`} title={`Notifications for this page: ${pageLevelLabel(q.level)}`} onClick={() => setOpen((v) => !v)}>
            {pageLevelIcon(q.level, 14)}
          </button>
          {open && (
            <span role="menu" aria-label="Notifications for this page" className="prism-page-level-menu" onKeyDown={onKeyDown}>
              {PAGE_NOTIFICATION_LEVELS.map((l) => (
                <button key={l.id} type="button" role="menuitemradio" aria-checked={q.level === l.id} className="prism-page-level-item focus-ring" disabled={q.saving}
                  onClick={() => { if (q.level !== l.id) q.set(l.id); close(); }}>
                  <span className="prism-page-level-check" aria-hidden>{q.level === l.id ? <Check size={14} /> : null}</span>
                  <span><strong>{l.label}</strong><small>{l.hint}</small></span>
                </button>
              ))}
            </span>
          )}
          {q.failed && <span role="alert" className="prism-page-level-error">Couldn’t save</span>}
        </span>
      )}
    </span>
  );
}
