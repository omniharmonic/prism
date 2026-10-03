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
  Check,
  Type,
  MoveHorizontal,
  Printer,
  ExternalLink,
  Share2,
  Search,
  Bot,
  LayoutTemplate,
} from "lucide-react";
import { requestFindInPage } from "../../lib/tiptap/findShortcuts";
import { useCollabSharing } from "../../data/CollabSharing";
import { openSharingDialog } from "../layout/SharingDialogHost";
import { openInNewTab } from "../../lib/pages/openInNewTab";
import { inferContentType } from "../../lib/schemas/content-types";
import { useOfflineAvailability } from "../../lib/offline/availability";
import { useNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { TEMPLATE_TAG, isLocked, isTrashed, pageStyleOf, protectionReason } from "../../lib/pages/model";
import { useViewerIsGuest } from "../sharing/SharedWithMe";
import { usePagesUI, type PageRef } from "../../lib/pages/store";
import { usePageActions, pageLink } from "../../lib/pages/usePageActions";
import { printCurrentPage, useTransferUI } from "../../lib/import-export/store";
import type { Note } from "../../lib/types";
import { PageInfo } from "../sharing/PageInfo";
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
  opts: { entry?: { path: string | null; tags: string[] | null } | null; onRename?: () => void; close: () => void; /** Phone page sheet: adds Share, Find and Agent (the desktop header has them as buttons). */ sheet?: boolean },
): PageMenuItem[] {
  const sharing = useCollabSharing();
  const actions = usePageActions();
  const { favoriteIds, toggleFavorite } = useNoteShortcuts();
  const real = isVaultNoteId(page.id);
  const { data: note } = useNote(real ? page.id : null);
  const subject = (note ?? opts.entry ?? { path: page.path, tags: [] }) as Pick<Note, "path" | "tags">;
  const locked = isLocked(note);
  const caps = (note as (Note & { _caps?: string[] }) | undefined)?._caps;
  const canEdit = !caps || caps.includes("edit");
  const protectedReason = protectionReason(subject);
  // NP-TX-01 "Save as template": for people who may create pages — never a guest, a
  // view/comment-only reader, a page that is already a template, or one in the Trash.
  const guest = useViewerIsGuest();
  const canTemplate = !!note && !guest && (!caps || caps.includes("create")) && !(note.tags ?? []).includes(TEMPLATE_TAG) && !isTrashed(note);
  const isFav = favoriteIds.includes(page.id);
  const offline = useOfflineAvailability(real ? page.id : null);
  // Per-page style (NP-PG-08): font = the page's own contentFont (the open
  // document registers its setter), small text / full width = prism_page_style.
  const docFont = useUIStore((s) => s.docFont);
  const docFontSetter = useUIStore((s) => s.docFontSetter);
  const activeNoteId = useUIStore((s) => s.openTabs.find((t) => t.id === s.activeTabId)?.noteId);
  const style = pageStyleOf(note);
  const run = (fn: () => void) => () => {
    opts.close();
    fn();
  };
  if (!real) return [];
  const isActive = activeNoteId === page.id;
  const native = typeof window !== "undefined" && !!(window as unknown as { __PRISM_HOST__?: unknown }).__PRISM_HOST__;
  /** Open this page (if it isn't the one in front) and run `then` once it is. */
  const onPage = (then: () => void) => {
    if (!isActive) useUIStore.getState().openTab(page.id, page.title, inferContentType(subject as Note));
    // After the sheet has closed and handed focus back.
    window.setTimeout(then, isActive ? 60 : 400);
  };
  const items: PageMenuItem[] = [
    {
      id: "favorite",
      label: isFav ? "Remove from Favorites" : "Add to Favorites",
      icon: <Star size={15} fill={isFav ? "var(--color-accent)" : "none"} />,
      onClick: run(() => toggleFavorite({ id: page.id, title: page.title, type: "document" })),
    },
    ...(opts.sheet && sharing?.getAccess
      ? [{ id: "share", label: "Share", icon: <Share2 size={15} />, onClick: run(() => openSharingDialog(page.id)) }]
      : []),
    // "Open in new tab" (NP-SB-07 / NP-PG-07). Another page: a tab behind the one
    // being read. The page already in front: a second browser tab on the same page
    // (the native app has one window, so it is not offered there).
    ...(!isActive
      ? [{ id: "open-new-tab", label: "Open in new tab", icon: <ExternalLink size={15} />, onClick: run(() => openInNewTab(page.id, page.title, inferContentType(subject as Note))) }]
      : !native && !opts.sheet
        ? [{ id: "open-new-tab", label: "Open in new tab", icon: <ExternalLink size={15} />, onClick: run(() => { window.open(pageLink(page.id), "_blank", "noopener"); }) }]
        : []),
    {
      id: "add-inside",
      label: "Add a page inside",
      icon: <FilePlus size={15} />,
      disabled: !subject.path || !!protectedReason,
      onClick: run(() => usePagesUI.getState().openCreate({ folder: subject.path ?? "" })),
    },
    ...(opts.onRename ? [{ id: "rename", label: "Rename", icon: <Pencil size={15} />, disabled: !!protectedReason || !canEdit, onClick: run(opts.onRename) }] : []),
    { id: "duplicate", label: "Duplicate", icon: <Copy size={15} />, disabled: !!protectedReason, onClick: run(() => void actions.duplicate(page)) },
    ...(canTemplate
      ? [{ id: "save-template", label: "Save as template", icon: <LayoutTemplate size={15} />, disabled: !!protectedReason, detail: protectedReason ?? undefined, onClick: run(() => void actions.saveAsTemplate(page)) }]
      : []),
    {
      id: "move",
      label: "Move to…",
      icon: <FolderInput size={15} />,
      disabled: !!protectedReason,
      detail: protectedReason ?? undefined,
      onClick: run(() => usePagesUI.getState().openMove({ ...page, path: subject.path ?? page.path })),
    },
    { id: "copy-link", label: "Copy link", icon: <Link2 size={15} />, startsGroup: true, onClick: run(() => void actions.copyLink(page)) },
    // NP-ED-22: find in page without a keyboard (the open page's editor answers).
    ...(activeNoteId === page.id ? [{ id: "find-in-page", label: "Find in page", icon: <Search size={15} />, onClick: run(() => { setTimeout(requestFindInPage, 60); }) }] : []),
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
    ...(docFontSetter && activeNoteId === page.id
      ? (["sans", "serif", "mono"] as const).map((font, i) => ({
          id: `font-${font}`,
          label: font === "sans" ? "Default font" : font === "serif" ? "Serif font" : "Mono font",
          icon: docFont === font ? <Check size={15} /> : <Type size={15} />,
          startsGroup: i === 0,
          detail: docFont === font ? "Current" : undefined,
          onClick: run(() => docFontSetter(font)),
        }))
      : []),
    ...(canEdit && note && !locked && activeNoteId === page.id
      ? [
          { id: "small-text", label: "Small text", icon: style.small ? <Check size={15} /> : <Type size={13} />, detail: style.small ? "On" : undefined, startsGroup: !(docFontSetter && activeNoteId === page.id), onClick: run(() => void actions.setPageStyle(note, { small: !style.small })) },
          { id: "full-width", label: "Full width", icon: style.full ? <Check size={15} /> : <MoveHorizontal size={15} />, detail: style.full ? "On" : undefined, onClick: run(() => void actions.setPageStyle(note, { full: !style.full })) },
        ]
      : []),
    { id: "export-md", label: "Export as Markdown", icon: <FileDown size={15} />, onClick: run(() => void actions.exportPage(page, "markdown")) },
    { id: "export-html", label: "Export as HTML", icon: <FileDown size={15} />, onClick: run(() => void actions.exportPage(page, "html")) },
    // Wave 3A: sub-pages + images as a ZIP, PDF via print (components/import-export).
    { id: "export-more", label: "Export…", icon: <FileDown size={15} />, detail: "Sub-pages, images, PDF", onClick: run(() => useTransferUI.getState().openExport({ scope: "page", page: { id: page.id, title: page.title, path: subject.path ?? page.path } })) },
    ...(activeNoteId === page.id ? [{ id: "print", label: "Print", icon: <Printer size={15} />, onClick: run(printCurrentPage) }] : []),
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
      // Integration-owned pages say why (NP-PG-07).
      detail: protectedReason ?? undefined,
      onClick: run(() => void actions.trash(page)),
    },
    ...(opts.sheet
      ? [{
          id: "agent",
          label: "Agent",
          icon: <Bot size={15} />,
          startsGroup: true,
          onClick: run(() => onPage(() => {
            const ui = useUIStore.getState();
            ui.setContextPanelTab("agent");
            if (!useUIStore.getState().contextPanelOpen) ui.toggleContextPanel();
          })),
        }]
      : []),
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
    // Items that depend on the page itself (lock, save as template) arrive once it has
    // loaded: the menu is placed again, or its last rows would hang below the window.
  }, [anchor.x, anchor.y, anchor.align, items.length]);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
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
  const rows = items.map((item) => (
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
        <span className="page-menu-label">
          {item.label}
          {/* A disabled action says why (a tooltip never shows on a disabled control). */}
          {item.disabled && item.detail && <small className="page-menu-detail">{item.detail}</small>}
        </span>
      </button>
    </div>
  ));
  // A footer (page info) is not a menu item: with one, the popup holds the menu and the footer side by side.
  if (footer) return (
    <div ref={ref} className="page-menu" style={pos} onKeyDown={onKeyDown}>
      <div role="menu" aria-label={label}>{rows}</div>
      {footer}
    </div>
  );
  return <div ref={ref} role="menu" aria-label={label} className="page-menu" style={pos} onKeyDown={onKeyDown}>{rows}</div>;
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
      {anchor && <PageMenuPopover label={`Actions for ${page.title}`} items={items} anchor={anchor} onClose={close} footer={<PageInfoFooter page={page} />} />}
    </>
  );
}

/** NP-PG-17: word count, created / last edited and who edited it, under the page's own ⋯ menu. */
function PageInfoFooter({ page }: { page: PageRef }) {
  const { data: note } = useNote(isVaultNoteId(page.id) ? page.id : null);
  return note ? <PageInfo note={note} /> : null;
}
