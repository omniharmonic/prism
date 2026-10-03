import { NoteShortcutsProvider } from "../navigation/NoteShortcuts";
import { useWorkspaceSession } from "../../app/hooks/useWorkspaceSession";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUIStore } from "../../app/stores/ui";
import { useKeyboardShortcuts } from "../../app/hooks/useKeyboardShortcuts";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { Navigation } from "../navigation/Navigation";
import { Canvas } from "./Canvas";
import { ContextPanel } from "./ContextPanel";
import { StatusBar } from "./StatusBar";
import { CommandBar } from "./CommandBar";
import { SharingDialogHost } from "./SharingDialogHost";
import { WikilinkChooser } from "./WikilinkChooser";
import { NotionDbSyncHost } from "./NotionDbSyncHost";
import { GraphFullscreen } from "./GraphFullscreen";
import { MobileActionBar } from "./MobileActionBar";
import { PagesHost } from "../pages/PagesHost";
import { VaultClientProvider, useOptionalVaultClient } from "../../data/VaultClientContext";
import { trackVaultWrites } from "../../lib/sync/syncState";
import { applyReduceMotion } from "../../lib/motion";

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
  const {
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    contextPanelOpen,
    contextPanelWidth,
    setContextPanelWidth,
  } = useUIStore();
  const activeTabId = useUIStore((s) => s.activeTabId);
  const isMobile = useIsMobile();
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
  useEffect(() => { applyReduceMotion(); }, []);
  const peek = useSidebarPeek(!isMobile && !sidebarOpen);
  const swipe = useEdgeSwipe(isMobile && !sidebarOpen);
  const restore = useWorkspaceSession();
  const restoreNotice = restore.state !== "idle" ? (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-2 text-xs text-[var(--text-secondary)]">
      <span>{restore.state === "loading" ? "Reopening your workspace…" : "Some previous tabs could not be reopened. Check your connection or document access."}</span>
      {restore.state === "partial" && <button className="focus-ring rounded px-2 py-1 text-[var(--text-accent)]" onClick={restore.retry}>Retry restore</button>}
      <button className="focus-ring rounded px-2 py-1" onClick={restore.dismiss}>{restore.state === "loading" ? "Cancel restore" : "Dismiss"}</button>
    </div>
  ) : null;

  // When the viewport becomes mobile, collapse the panels so the canvas is
  // visible; they reopen as overlay drawers on demand.
  useEffect(() => {
    if (isMobile) useUIStore.setState({ sidebarOpen: false, contextPanelOpen: false });
  }, [isMobile]);

  // On mobile, opening a document should dismiss the sidebar drawer.
  const prevTab = useRef(activeTabId);
  useEffect(() => {
    if (isMobile && activeTabId && activeTabId !== prevTab.current) {
      useUIStore.setState({ sidebarOpen: false });
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
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
    boxSizing: "border-box",
  };

  return (
    <NoteShortcutsProvider><div className="flex flex-col overflow-hidden" style={rootStyle}>
      {restoreNotice}
      <a className="workspace-skip-link" href="#workspace-document">Skip to document</a>
      <div ref={layoutRef} key="workspace" className="relative flex flex-1 min-h-0">
        {!isMobile && sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth, minWidth: 200, maxWidth: 400 }} className="flex-shrink-0">
              <Navigation />
            </div>
            <ResizeHandle onResize={setSidebarWidth} initialSize={sidebarWidth} side="left" />
          </>
        )}

        {!isMobile && !sidebarOpen && (
          <div key="sidebar-peek-zone" className="sidebar-peek-zone" data-testid="sidebar-peek-zone" aria-hidden onMouseEnter={peek.enter} onMouseLeave={peek.leave} />
        )}
        {!isMobile && !sidebarOpen && peek.open && (
          <div key="sidebar-peek" className="sidebar-peek" role="complementary" aria-label="Sidebar preview"
            onMouseEnter={peek.enter} onMouseLeave={peek.leave}>
            <Navigation />
          </div>
        )}
        {isMobile && <div key="edge-swipe" className="edge-swipe-hint" data-active={swipe ? "true" : "false"} aria-hidden />}

        {/* Keep this parent and Canvas mounted across breakpoints. Responsive
            navigation must not recreate an editor, socket, thread or draft. */}
        <div key="document" className="flex-1 min-w-0 min-h-0" style={{ "--workspace-bottom-inset": isMobile ? "76px" : "0px" } as React.CSSProperties}>
          <Canvas />
        </div>

        {!companionOverlay && contextPanelOpen && (
          <>
            <ResizeHandle onResize={setContextPanelWidth} initialSize={contextPanelWidth} side="right" />
            <div style={{ width: contextPanelWidth, minWidth: 260, maxWidth: 480 }} className="flex-shrink-0">
              <ContextPanel />
            </div>
          </>
        )}
        {isMobile && sidebarOpen && (
          <MobileDrawer key="mobile-navigation" side="left" onClose={() => useUIStore.setState({ sidebarOpen: false })}>
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
      {!isMobile && <StatusBar key="status" />}
      <CommandBar key="commands" />
      <WikilinkChooser key="wikilinks" />
      <SharingDialogHost key="sharing" />
      <NotionDbSyncHost key="notion-sync" />
      <GraphFullscreen key="graph" />
      <PagesHost key="pages" />
    </div></NoteShortcutsProvider>
  );
}

/** Slide-in overlay panel for mobile: a backdrop that dismisses on tap plus a
 *  fixed-position drawer pinned to one edge. */
function MobileDrawer({
  side,
  onClose,
  children,
  compact = false,
}: {
  compact?: boolean;
  side: "left" | "right";
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog ref={dialogRef} className="workspace-mobile-drawer" data-side={side} aria-label={side === "left" ? "Workspace navigation" : "Document panel"}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{ left: side === "left" ? 0 : "auto", right: side === "right" ? 0 : "auto", width: side === "right" ? (compact ? "min(420px, 100vw)" : "100%") : "min(88vw, 360px)" }}>
      <div className="h-full min-h-0 flex flex-col" style={{ background: "var(--bg-surface)" }}>
        {side === "left" && <div className="workspace-context-header flex items-center justify-between px-4 shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <span className="text-sm font-medium">Workspace</span>
          <button type="button" aria-label="Close navigation" onClick={onClose}
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
  const activeTabId = useUIStore((s) => s.activeTabId);
  const clear = () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  const enter = useCallback(() => { clear(); timer.current = window.setTimeout(() => setOpen(true), 80); }, []);
  const leave = useCallback(() => { clear(); timer.current = window.setTimeout(() => setOpen(false), 220); }, []);
  useEffect(() => { if (!enabled) { clear(); setOpen(false); } }, [enabled]);
  useEffect(() => { setOpen(false); }, [activeTabId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { clear(); setOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => clear, []);
  return { open: enabled && open, enter, leave };
}

/**
 * NP-MB-06: on phones a swipe that STARTS within 20 px of the left edge goes
 * back (when there is somewhere to go) or opens the Browse drawer. It never
 * starts mid-screen, so it doesn't fight text selection, horizontal scrollers
 * or the editor; visible Back and Browse buttons remain the alternatives.
 */
const EDGE_PX = 20;
const SWIPE_PX = 64;
function useEdgeSwipe(enabled: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!enabled) { setActive(false); return; }
    let start: { x: number; y: number } | null = null;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX > EDGE_PX) { start = null; return; }
      const target = e.target as Element | null;
      if (target?.closest?.("dialog[open], [role=dialog], [data-no-edge-swipe]")) { start = null; return; }
      start = { x: t.clientX, y: t.clientY };
      tracking = true;
      setActive(true);
    };
    const onMove = (e: TouchEvent) => {
      if (!start || !tracking) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientY - start.y) > 48 && Math.abs(t.clientY - start.y) > (t.clientX - start.x)) { tracking = false; setActive(false); }
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      const began = start;
      start = null;
      setActive(false);
      if (!began || !tracking || !t) return;
      tracking = false;
      const dx = t.clientX - began.x;
      const dy = Math.abs(t.clientY - began.y);
      if (dx < SWIPE_PX || dy > dx * 0.6) return;
      if (window.getSelection()?.toString()) return;
      const ui = useUIStore.getState();
      const open = new Set(ui.openTabs.map((tab) => tab.id));
      const canBack = ui.navHistory.slice(0, Math.max(0, ui.navIndex)).some((id) => open.has(id));
      if (canBack) ui.navBack();
      else useUIStore.setState({ sidebarOpen: true });
    };
    const cancel = () => { start = null; tracking = false; setActive(false); };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", cancel);
    };
  }, [enabled]);
  return active;
}
