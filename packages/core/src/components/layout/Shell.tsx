import { NoteShortcutsProvider } from "../navigation/NoteShortcuts";
import { takeAutomaticTab, useWorkspaceSession } from "../../app/hooks/useWorkspaceSession";
import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRegionPrefs } from "../../lib/datetime/useRegionPrefs";
import { useUIStore, persistSidebar } from "../../app/stores/ui";
import { useKeyboardShortcuts } from "../../app/hooks/useKeyboardShortcuts";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { Navigation } from "../navigation/Navigation";
import { Canvas } from "./Canvas";
import { ContextPanel } from "./ContextPanel";
import { Settings } from "./Settings";
import { CommandBar } from "./CommandBar";
import { SharingDialogHost } from "./SharingDialogHost";
import { WikilinkChooser } from "./WikilinkChooser";
import { NotionDbSyncHost } from "./NotionDbSyncHost";
import { GraphFullscreen } from "./GraphFullscreen";
import { MobileActionBar } from "./MobileActionBar";
import { PagesHost } from "../pages/PagesHost";
import { ImportExportHost } from "../import-export/ImportExportHost";
import { PageAgentHost } from "../agent/PageAgentPanel";
import { VaultClientProvider, useOptionalVaultClient } from "../../data/VaultClientContext";
import { trackVaultWrites } from "../../lib/sync/syncState";
import { applyReduceMotion } from "../../lib/motion";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/parachute/queries";

/** Every write made inside the shell moves the one truthful sync state (NP-OF-01). */
function TrackedVaultWrites({ children }: { children: React.ReactNode }) {
  const client = useOptionalVaultClient();
  if (!client) return <>{children}</>;
  return <VaultClientProvider client={trackVaultWrites(client)}>{children}</VaultClientProvider>;
}

export function Shell() {
  return <TrackedVaultWrites><ShellLayout /></TrackedVaultWrites>;
}

function ShellLayout() {
  // Dates everywhere under the shell are written by lib/datetime/format, which reads the regional
  // preferences synchronously: re-render the workspace when one changes (NP-AX-09).
  useRegionPrefs();
  const {
    sidebarOpen: requestedSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    contextPanelOpen: requestedContextOpen,
    contextPanelWidth,
    setContextPanelWidth,
  } = useUIStore();
  const activeTabId = useUIStore((s) => s.activeTabId);
  const isMobile = useIsMobile();
  const focusMode = useUIStore(s => s.focusMode) && !isMobile;
  const sidebarOpen = requestedSidebarOpen && !focusMode;
  const contextPanelOpen = requestedContextOpen && !focusMode;
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const node = layoutRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setLayoutWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Keep a useful writing measure when the two sidebars no longer fit. Saved
  // widths stay intact; the companion becomes a dismissible overlay instead.
  const companionOverlay = isMobile || layoutWidth - (sidebarOpen ? sidebarWidth + 4 : 0) - contextPanelWidth - 4 < 480;

  useKeyboardShortcuts();
  // NP-SB-11: remember the desktop sidebar (width + collapsed) on this device.
  // Phones use the same flag for their drawer, which must never be remembered.
  useEffect(() => { if (!isMobile) persistSidebar(requestedSidebarOpen, sidebarWidth); }, [isMobile, requestedSidebarOpen, sidebarWidth]);
  useEffect(() => { applyReduceMotion(); }, []);
  // The host's outbox confirmed one of OUR queued writes (this tab or another):
  // re-read that page so the cached revision is the server's, without waiting
  // for the events channel.
  const queryClient = useQueryClient();
  useEffect(() => {
    const confirmed = (event: Event) => {
      const id = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(id) });
    };
    // A saved-on-device change was discarded: reload the page from the server and
    // remount its editor, so nothing typed next is built on the discarded text.
    const discarded = (event: Event) => {
      const id = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(id) }).then(() => useUIStore.getState().bumpNoteRevision(id));
    };
    window.addEventListener("prism:note-confirmed", confirmed);
    window.addEventListener("prism:note-discarded", discarded);
    return () => { window.removeEventListener("prism:note-confirmed", confirmed); window.removeEventListener("prism:note-discarded", discarded); };
  }, [queryClient]);
  const peek = useSidebarPeek(!isMobile && !sidebarOpen && !focusMode);
  const swipe = useEdgeSwipe(isMobile && !sidebarOpen);
  useEffect(() => {
    const pointer = () => { document.documentElement.dataset.pointerFocus = "true"; };
    const keyboard = () => { delete document.documentElement.dataset.pointerFocus; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete document.documentElement.dataset.pointerFocus;
    };
  }, []);
  const restore = useWorkspaceSession();
  const restoreNotice = restore.state !== "idle" ? (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-2 text-xs text-[var(--text-secondary)]">
      <span>{restore.state === "loading" ? "Reopening your workspace…" : "Some previous tabs could not be reopened. Check your connection or document access."}</span>
      {restore.state === "partial" && <button className="focus-ring rounded px-2 py-1 text-[var(--text-accent)]" onClick={restore.retry}>Retry restore</button>}
      <button className="focus-ring rounded px-2 py-1" onClick={restore.dismiss}>{restore.state === "loading" ? "Cancel restore" : "Dismiss"}</button>
    </div>
  ) : null;

  // When the viewport becomes mobile, collapse the panels so the canvas is
  // visible; they reopen as overlay drawers on demand. Before paint: a workspace mounted on a
  // phone with the desktop's "sidebar open" flag showed the drawer for a frame and shut it.
  useLayoutEffect(() => {
    if (isMobile) useUIStore.setState({ sidebarOpen: false, contextPanelOpen: false });
  }, [isMobile]);

  // On mobile, opening a document should dismiss the sidebar drawer — when a PERSON opened
  // it. A workspace being restored (or Home after a vault switch) becomes the active tab
  // whenever the server answers; that used to shut a drawer the reader had opened meanwhile.
  const prevTab = useRef(activeTabId);
  useEffect(() => {
    if (activeTabId !== prevTab.current) {
      const automatic = takeAutomaticTab(activeTabId);
      if (isMobile && activeTabId && !automatic) useUIStore.setState({ sidebarOpen: false });
    }
    prevTab.current = activeTabId;
  }, [activeTabId, isMobile]);

  // Dynamic viewport height + safe-area insets so the top/bottom bars stay
  // reachable in an installed PWA (under the iOS notch / home indicator); 100dvh
  // matches the standalone viewport, which 100vh (h-screen) overshoots.
  const rootStyle: React.CSSProperties = {
    height: "100dvh",
    width: "100%",
    background: "var(--bg-base)",
    color: "var(--text-primary)",
    paddingTop: "var(--prism-safe-area-top, env(safe-area-inset-top))",
    paddingBottom: "var(--prism-safe-area-bottom, env(safe-area-inset-bottom))",
    paddingLeft: "var(--prism-safe-area-left, env(safe-area-inset-left))",
    paddingRight: "var(--prism-safe-area-right, env(safe-area-inset-right))",
    boxSizing: "border-box",
  };

  return (
    <NoteShortcutsProvider><div className="prism-workspace-shell flex flex-col overflow-hidden" style={rootStyle}>
      {restoreNotice}
      <a className="workspace-skip-link" href="#workspace-document">Skip to document</a>
      <div ref={layoutRef} key="workspace" className="prism-workspace-layout relative flex flex-1 min-h-0">
        {!isMobile && sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth, minWidth: 200, maxWidth: 400 }} className="flex-shrink-0">
              <Navigation />
            </div>
            <ResizeHandle onResize={setSidebarWidth} initialSize={sidebarWidth} side="left" />
          </>
        )}

        {/* The pinned sidebar and the peek are mutually exclusive, so there is only
            ever ONE <Navigation/> mounted on desktop. Keyboard: the first tab stop
            after the skip link opens the peek and moves focus into it. */}
        {!isMobile && !sidebarOpen && !focusMode && (
          <div key="sidebar-peek-zone" className="sidebar-peek-zone" data-testid="sidebar-peek-zone" onMouseEnter={peek.enter} onMouseLeave={peek.leave}>
            <button ref={peek.trigger} type="button" className="sidebar-peek-trigger" aria-expanded={peek.open} aria-controls="sidebar-peek" onClick={peek.toggle}>
              {peek.open ? "Hide sidebar preview" : "Show sidebar preview"}
            </button>
          </div>
        )}
        {!isMobile && !sidebarOpen && peek.open && (
          <div key="sidebar-peek" id="sidebar-peek" ref={peek.panel} className="sidebar-peek" role="complementary" aria-label="Sidebar preview" tabIndex={-1}
            onMouseEnter={peek.enter} onMouseLeave={peek.leave} onBlur={peek.blur}>
            <Navigation />
          </div>
        )}
        {isMobile && <div key="edge-swipe" className="edge-swipe-hint" data-active={swipe !== null ? "true" : "false"} aria-hidden />}

        {/* Keep this parent and Canvas mounted across breakpoints. Responsive
            navigation must not recreate an editor, socket, thread or draft. */}
        <div key="document" className="prism-workspace-canvas flex-1 min-w-0 min-h-0" style={{ "--workspace-bottom-inset": isMobile ? "76px" : "0px" } as React.CSSProperties}>
          <Canvas />
        </div>

        {!companionOverlay && contextPanelOpen && (
          <>
            <ResizeHandle onResize={setContextPanelWidth} initialSize={contextPanelWidth} side="right" />
            <div style={{ width: contextPanelWidth, minWidth: 260, maxWidth: 480 }} className="prism-workspace-companion flex-shrink-0">
              <ContextPanel />
            </div>
          </>
        )}
        {isMobile && (sidebarOpen || swipe !== null) && (
          <MobileDrawer key="mobile-navigation" dragDistance={sidebarOpen ? undefined : swipe ?? undefined} side="left" onClose={() => useUIStore.setState({ sidebarOpen: false })}>
            <Navigation />
          </MobileDrawer>
        )}
        {companionOverlay && contextPanelOpen && (
          <MobileDrawer key="mobile-panel" side="right" compact={!isMobile} onClose={() => useUIStore.setState({ contextPanelOpen: false })}>
            <ContextPanel />
          </MobileDrawer>
        )}
        {isMobile && <MobileActionBar key="mobile-actions" />}
      </div>
      {/* The desktop status bar is gone (w16): its count, service health and font moved to
          Settings → Services and the page ⋯ menu. The Settings dialog is mounted here on desktop
          (MobileActionBar mounts it on phones). */}
      {!isMobile && <SettingsHost key="settings" />}
      <CommandBar key="commands" />
      <WikilinkChooser key="wikilinks" />
      <SharingDialogHost key="sharing" />
      <NotionDbSyncHost key="notion-sync" />
      <GraphFullscreen key="graph" />
      <PagesHost key="pages" />
      <ImportExportHost key="import-export" />
      <PageAgentHost key="page-agent" />
    </div></NoteShortcutsProvider>
  );
}

function SettingsHost() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  return <Settings open={open} onClose={() => setOpen(false)} />;
}

/** Slide-in overlay panel for mobile: a backdrop that dismisses on tap plus a
 *  fixed-position drawer pinned to one edge. */
function MobileDrawer({
  side,
  onClose,
  children,
  compact = false,
  dragDistance,
}: {
  dragDistance?: number;
  compact?: boolean;
  side: "left" | "right";
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const dragging = dragDistance !== undefined;
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduce-motion");
  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    if (reduceMotion()) { onClose(); return; }
    const animation = dialog.animate([
      { transform: getComputedStyle(dialog).transform },
      { transform: `translateX(${side === "left" ? "-100%" : "100%"})` },
    ], { duration: 240, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
    void animation.finished.then(onClose).catch(() => {});
  }, [onClose, side]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    previousFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      dialog?.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dragging) {
      // A non-modal preview must not steal the ongoing touch from the editor.
      dialog.setAttribute("open", "");
    } else {
      const from = getComputedStyle(dialog).transform;
      dialog.close();
      dialog.style.transform = "";
      dialog.showModal();
      dialog.focus({ preventScroll: true });
      if (!reduceMotion()) dialog.animate([
        { transform: from === "none" ? `translateX(${side === "left" ? "-100%" : "100%"})` : from },
        { transform: "translateX(0)" },
      ], { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" });
    }
  }, [dragging, side]);
  useLayoutEffect(() => {
    if (dragDistance === undefined || !dialogRef.current) return;
    const dialog = dialogRef.current;
    dialog.style.transition = dragDistance === 0 && !reduceMotion() ? "transform 240ms cubic-bezier(.22,1,.36,1)" : "none";
    dialog.style.transform = `translateX(${Math.min(0, dragDistance - dialog.getBoundingClientRect().width)}px)`;
  }, [dragDistance]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || side !== "left" || dragging) return;
    let start: { x: number; y: number; at: number } | null = null;
    let claimed = false;
    const cancel = () => { start = null; claimed = false; dialog.style.transform = ""; dialog.style.transition = reduceMotion() ? "none" : "transform 240ms cubic-bezier(.22,1,.36,1)"; };
    const begin = (event: TouchEvent) => {
      claimed = false;
      const touch = event.touches[0];
      const target = event.target as Element | null;
      if (event.touches.length !== 1 || !touch || window.getSelection()?.toString() ||
          target?.closest("input, textarea, select, [contenteditable], [role=slider], canvas, [data-no-edge-swipe]")) { cancel(); return; }
      for (let node: Element | null = target; node && node !== dialog; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) { cancel(); return; }
      }
      start = { x: touch.clientX, y: touch.clientY, at: performance.now() };
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || event.touches.length !== 1 || !touch) { cancel(); return; }
      const dx = start.x - touch.clientX;
      if (dx >= 12 && Math.abs(touch.clientY - start.y) < dx * .6) claimed = true;
      if (claimed) { if (event.cancelable) event.preventDefault(); event.stopPropagation(); dialog.style.transition = "none"; dialog.style.transform = `translateX(${-Math.max(0, dx)}px)`; }
      if (Math.abs(touch.clientY - start.y) > 24 && Math.abs(touch.clientY - start.y) > Math.abs(touch.clientX - start.x)) cancel();
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0], began = start;
      if (claimed) { if (event.cancelable) event.preventDefault(); event.stopPropagation(); }
      const offset = dialog.style.transform;
      cancel();
      if (!began || !touch || window.getSelection()?.toString()) return;
      const distance = began.x - touch.clientX;
      if (distance >= SWIPE_PX && Math.abs(touch.clientY - began.y) < distance * .6 && performance.now() - began.at <= 900) { dialog.style.transform = offset; close(); }
    };
    dialog.addEventListener("touchstart", begin, { passive: true });
    dialog.addEventListener("touchmove", move, { passive: false, capture: true });
    dialog.addEventListener("touchend", end, { passive: false, capture: true });
    dialog.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      dialog.removeEventListener("touchstart", begin); dialog.removeEventListener("touchmove", move, true);
      dialog.removeEventListener("touchend", end, true); dialog.removeEventListener("touchcancel", cancel);
    };
  }, [side, close, dragging]);
  return (
    <dialog ref={dialogRef} tabIndex={-1} data-dragging={dragging || undefined} className="workspace-mobile-drawer" data-side={side} aria-label={side === "left" ? "Workspace navigation" : "Document panel"}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      style={{ left: side === "left" ? 0 : "auto", right: side === "right" ? 0 : "auto", width: side === "right" ? (compact ? "min(420px, 100vw)" : "100%") : "min(88vw, 360px)" }}>
      <div className="h-full min-h-0 flex flex-col" style={{ background: "var(--bg-surface)" }}>
        {side === "left" && <div className="workspace-context-header flex items-center justify-between px-4 shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <span className="text-sm font-medium">Workspace</span>
          <button type="button" aria-label="Close navigation" onClick={close}
            className="interactive flex items-center justify-center" style={{ width: 44, height: 44 }}><X size={20} /></button>
        </div>}
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </dialog>
  );
}

// Resize handle between panels
function ResizeHandle({
  onResize,
  initialSize,
  side,
}: {
  onResize: (size: number) => void;
  initialSize: number;
  side: "left" | "right";
}) {
  const startX = useRef(0);
  const startSize = useRef(initialSize);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      startX.current = e.clientX;
      startSize.current = initialSize;

      const onMouseMove = (e: MouseEvent) => {
        const delta = e.clientX - startX.current;
        const newSize = side === "left"
          ? startSize.current + delta
          : startSize.current - delta;
        onResize(newSize);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [initialSize, onResize, side],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize hover:bg-accent/30 transition-colors flex-shrink-0"
      style={{ background: "var(--glass-border)" }}
    />
  );
}

/**
 * NP-SB-12: with the sidebar collapsed, resting the pointer on the left edge
 * reveals it as a floating overlay. Small enter/leave delays stop accidental
 * flicker; Esc, opening a page, or leaving the overlay dismisses it.
 */
function useSidebarPeek(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Opened from the keyboard: stays until Esc / focus leaves (mouse-out doesn't close it). */
  const pinned = useRef(false);
  const activeTabId = useUIStore((s) => s.activeTabId);
  const clear = () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  const close = useCallback((refocus: boolean) => {
    clear();
    const hadFocus = !!panel.current?.contains(document.activeElement);
    pinned.current = false;
    setOpen(false);
    if (refocus && hadFocus) trigger.current?.focus();
  }, []);
  const enter = useCallback(() => { clear(); timer.current = window.setTimeout(() => setOpen(true), 80); }, []);
  const leave = useCallback(() => { clear(); if (!pinned.current) timer.current = window.setTimeout(() => setOpen(false), 220); }, []);
  const toggle = useCallback(() => {
    clear();
    if (pinned.current) { close(true); return; }
    pinned.current = true;
    setOpen(true);
  }, [close]);
  const blur = useCallback((event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (pinned.current && next && !panel.current?.contains(next) && next !== trigger.current) close(false);
  }, [close]);
  // Keyboard open: move focus into the preview once it exists.
  useEffect(() => {
    if (open && pinned.current) (panel.current?.querySelector<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])") ?? panel.current)?.focus();
  }, [open]);
  useEffect(() => { if (!enabled) { clear(); pinned.current = false; setOpen(false); } }, [enabled]);
  useEffect(() => { pinned.current = false; setOpen(false); }, [activeTabId]);
  // Listen for the whole time the peek is possible (not only once it opened), so
  // an Esc in the first frame after it appears is never missed.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, close]);
  useEffect(() => clear, []);
  return { open: enabled && open, enter, leave, toggle, blur, trigger, panel };
}

/**
 * The outer 14px always opens phone navigation without intercepting taps.
 * Between 14–32px, only unambiguous noninteractive content can navigate back;
 * header space opens navigation. Editors/graphs keep all other gestures.
 */
const NAV_EDGE_PX = 14;
const EDGE_PX = 32;
const SWIPE_PX = 64;
function useEdgeSwipe(enabled: boolean): number | null {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) { setActive(null); return; }
    let start: { x: number; y: number; at: number; navigation: boolean } | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const retract = () => {
      setActive(value => value === null ? null : 0);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setActive(null), 240);
    };
    let tracking = false;
    let claimed = false;
    // Reserved edge: do not let a graph/drag handler initialize before we know
    // whether this is navigation. Default taps and vertical scrolling still run.
    const onPointerStart = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (event.pointerType === "touch" && event.clientX >= 0 && event.clientX <= NAV_EDGE_PX &&
          !window.getSelection()?.toString() && !target?.closest?.("dialog[open], [role=dialog]")) event.stopPropagation();
    };
    const onStart = (e: TouchEvent) => {
      claimed = false;
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX > EDGE_PX) { start = null; return; }
      const target = e.target as Element | null;
      const navigationEdge = t.clientX >= 0 && t.clientX <= NAV_EDGE_PX;
      if (target?.closest?.("dialog[open], [role=dialog]") || window.getSelection()?.toString() || (!navigationEdge && target?.closest?.("[data-no-edge-swipe], [contenteditable]:not([contenteditable=false]), input, textarea, select, button, a, summary, [role=slider], canvas, svg, .tiptap, .monaco-editor, .cm-editor, .excalidraw"))) { start = null; return; }
      // A table, board, code block or any other sideways scroller owns its own
      // horizontal drag — even when it starts at the screen edge.
      for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
        if (!navigationEdge && node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) { start = null; return; }
      }
      if (navigationEdge) e.stopPropagation();
      start = { x: t.clientX, y: t.clientY, at: performance.now(), navigation: navigationEdge || !!target?.closest(".tabbar-phone, .document-page-header") };
      tracking = true;
      clearTimeout(settleTimer);
      setActive(null);
    };
    const onMove = (e: TouchEvent) => {
      if (!start || !tracking) return;
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) { tracking = false; setActive(null); return; }
      if (t.clientX - start.x >= 12 && Math.abs(t.clientY - start.y) < (t.clientX - start.x) * .6) claimed = true;
      if (claimed) {
        if (start.navigation) setActive(Math.max(0, t.clientX - start.x));
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
      if (Math.abs(t.clientY - start.y) > 48 && Math.abs(t.clientY - start.y) > (t.clientX - start.x)) { tracking = false; setActive(null); }
    };
    const onEnd = (e: TouchEvent) => {
      if (claimed) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); }
      claimed = false;
      const t = e.changedTouches[0];
      const began = start;
      start = null;
      if (!began || !tracking || !t) { retract(); return; }
      tracking = false;
      const dx = t.clientX - began.x;
      const dy = Math.abs(t.clientY - began.y);
      if (dx < SWIPE_PX || dy > dx * 0.6 || performance.now() - began.at > 900) { retract(); return; }
      if (window.getSelection()?.toString()) { retract(); return; }
      setActive(null);
      const ui = useUIStore.getState();
      const open = new Set(ui.openTabs.map((tab) => tab.id));
      const canBack = ui.navHistory.slice(0, Math.max(0, ui.navIndex)).some((id) => open.has(id));
      if (canBack && !began.navigation) ui.navBack();
      else useUIStore.setState({ sidebarOpen: true });
    };
    const cancel = () => { start = null; tracking = false; claimed = false; retract(); };
    document.addEventListener("pointerdown", onPointerStart, { passive: true, capture: true });
    document.addEventListener("touchstart", onStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onMove, { passive: false, capture: true });
    document.addEventListener("touchend", onEnd, { passive: false, capture: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      clearTimeout(settleTimer);
      document.removeEventListener("pointerdown", onPointerStart, true);
      document.removeEventListener("touchstart", onStart, true);
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("touchend", onEnd, true);
      document.removeEventListener("touchcancel", cancel);
    };
  }, [enabled]);
  return active;
}
