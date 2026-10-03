import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import {
  Copy,
  FileDown,
  FilePlus,
  FolderInput,
  History,
  Link2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
  CloudDownload,
  CloudOff,
} from "lucide-react";
import { useOfflineAvailability } from "../../lib/offline/availability";
import { useNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { isLocked, protectionReason } from "../../lib/pages/model";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { usePageActions } from "../../lib/pages/usePageActions";
import type { Note } from "../../lib/types";
import "./pages.css";

export interface PageMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  startsGroup?: boolean;
  disabled?: boolean;
  detail?: string;
}

/**
 * The page `⋯` menu: one list of actions shared by the top bar, the sidebar row
 * and the phone sheet. `entry` (tags/path from the tree) answers protection
 * before the note body loads; the note answers lock state and `_caps`.
 */
export function usePageMenuItems(
  page: PageRef,
  opts: { entry?: { path: string | null; tags: string[] | null } | null; onRename?: () => void; close: () => void },
): PageMenuItem[] {
  const actions = usePageActions();
  const { favoriteIds, toggleFavorite } = useNoteShortcuts();
  const real = isVaultNoteId(page.id);
  const { data: note } = useNote(real ? page.id : null);
  const subject = (note ?? opts.entry ?? { path: page.path, tags: [] }) as Pick<Note, "path" | "tags">;
  const locked = isLocked(note);
  const caps = (note as (Note & { _caps?: string[] }) | undefined)?._caps;
  const canEdit = !caps || caps.includes("edit");
  const protectedReason = protectionReason(subject);
  const isFav = favoriteIds.includes(page.id);
  const offline = useOfflineAvailability(real ? page.id : null);
  const run = (fn: () => void) => () => {
    opts.close();
    fn();
  };
  if (!real) return [];
  const items: PageMenuItem[] = [
    {
      id: "favorite",
      label: isFav ? "Remove from Favorites" : "Add to Favorites",
      icon: <Star size={15} fill={isFav ? "var(--color-accent)" : "none"} />,
      onClick: run(() => toggleFavorite({ id: page.id, title: page.title, type: "document" })),
    },
    {
      id: "add-inside",
      label: "Add a page inside",
      icon: <FilePlus size={15} />,
      disabled: !subject.path || !!protectedReason,
      onClick: run(() => usePagesUI.getState().openCreate({ folder: subject.path ?? "" })),
    },
    ...(opts.onRename ? [{ id: "rename", label: "Rename", icon: <Pencil size={15} />, disabled: !!protectedReason || !canEdit, onClick: run(opts.onRename) }] : []),
    { id: "duplicate", label: "Duplicate", icon: <Copy size={15} />, disabled: !!protectedReason, onClick: run(() => void actions.duplicate(page)) },
    {
      id: "move",
      label: "Move to…",
      icon: <FolderInput size={15} />,
      disabled: !!protectedReason,
      detail: protectedReason ?? undefined,
      onClick: run(() => usePagesUI.getState().openMove({ ...page, path: subject.path ?? page.path })),
    },
    { id: "copy-link", label: "Copy link", icon: <Link2 size={15} />, startsGroup: true, onClick: run(() => void actions.copyLink(page)) },
    ...(canEdit && note
      ? [{
          id: "lock",
          label: locked ? "Unlock page" : "Lock page",
          icon: locked ? <LockOpen size={15} /> : <Lock size={15} />,
          onClick: run(() => void actions.toggleLock(note)),
        }]
      : []),
    ...(offline.supported
      ? [{
          id: "offline",
          label: offline.available ? "Remove offline copy" : "Make available offline",
          icon: offline.available ? <CloudOff size={15} /> : <CloudDownload size={15} />,
          detail: offline.available ? "Available offline on this device" : undefined,
          onClick: run(offline.toggle),
        }]
      : []),
    { id: "export-md", label: "Export as Markdown", icon: <FileDown size={15} />, onClick: run(() => void actions.exportPage(page, "markdown")) },
    { id: "export-html", label: "Export as HTML", icon: <FileDown size={15} />, onClick: run(() => void actions.exportPage(page, "html")) },
    {
      id: "history",
      label: "Version history",
      icon: <History size={15} />,
      onClick: run(() => {
        const ui = useUIStore.getState();
        ui.openTab(page.id, page.title, "document");
        ui.setContextPanelTab("history");
        if (!useUIStore.getState().contextPanelOpen) ui.toggleContextPanel();
      }),
    },
    {
      id: "trash",
      label: "Move to Trash",
      icon: <Trash2 size={15} />,
      danger: true,
      startsGroup: true,
      disabled: !!protectedReason,
      onClick: run(() => void actions.trash(page)),
    },
  ];
  return items;
}

/** A positioned desktop menu (role=menu) with arrow-key navigation. */
export function PageMenuPopover({
  label,
  items,
  anchor,
  onClose,
  footer,
}: {
  label: string;
  items: PageMenuItem[];
  anchor: { x: number; y: number; align?: "left" | "right" };
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    let left = anchor.align === "right" ? anchor.x - width : anchor.x;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8));
    setPos({ left, top });
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [anchor.x, anchor.y, anchor.align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return (
    <div ref={ref} role="menu" aria-label={label} className="page-menu" style={pos} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <div key={item.id}>
          {item.startsGroup && <div className="page-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="page-menu-item"
            data-danger={item.danger || undefined}
            disabled={item.disabled}
            title={item.detail}
            onClick={item.onClick}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
      {footer}
    </div>
  );
}

/** The `⋯` button for the active page (top bar). Desktop: popover; phone: the actions sheet.
 *  Renders nothing outside a data context (standalone toolbar previews). */
export function PageActionsButton(props: { page: PageRef; size?: number }) {
  const queries = useContext(QueryClientContext);
  const vault = useOptionalVaultClient();
  return queries && vault ? <PageActionsTrigger {...props} /> : null;
}

function PageActionsTrigger({ page, size = 16 }: { page: PageRef; size?: number }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; align: "right" } | null>(null);
  const isMobile = useIsMobile();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setAnchor(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };
  const items = usePageMenuItems(page, { close });
  if (!items.length) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        title="Page actions"
        aria-label="Page actions"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        className="interactive focus-ring flex items-center justify-center flex-shrink-0"
        style={{ width: 30, height: 30, color: "var(--text-muted)" }}
        onClick={(e) => {
          if (isMobile) {
            usePagesUI.getState().openActions(page);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor(anchor ? null : { x: r.right, y: r.bottom + 6, align: "right" });
        }}
      >
        <MoreHorizontal size={size} />
      </button>
      {anchor && <PageMenuPopover label={`Actions for ${page.title}`} items={items} anchor={anchor} onClose={close} />}
    </>
  );
}
