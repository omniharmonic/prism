import { useWorkspaceSession } from "../../app/hooks/useWorkspaceSession";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
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

export function Shell() {
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

  useKeyboardShortcuts();
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

  if (isMobile) {
    return (
      <div className="flex flex-col overflow-hidden" style={rootStyle}>
        {restoreNotice}
        <a className="workspace-skip-link" href="#workspace-document">Skip to document</a>
        <div className="relative flex-1 min-h-0">
          {/* Canvas fills the screen; the pill floats over it and content scrolls
              beneath (renderers add bottom clearance so the last line clears). */}
          <div className="absolute inset-0">
            <Canvas />
          </div>

          {/* Sidebar as a left drawer */}
          {sidebarOpen && (
            <MobileDrawer side="left" onClose={() => useUIStore.setState({ sidebarOpen: false })}>
              <Navigation />
            </MobileDrawer>
          )}

          {/* Context panel as a right drawer */}
          {contextPanelOpen && (
            <MobileDrawer side="right" onClose={() => useUIStore.setState({ contextPanelOpen: false })}>
              <ContextPanel />
            </MobileDrawer>
          )}

          {/* Floating command pill — the mobile navigation/action surface.
              Replaces the bottom StatusBar; Settings + sync live in its More sheet. */}
          <MobileActionBar />
        </div>

        <CommandBar key="commands" />
        <WikilinkChooser key="wikilinks" />
        <SharingDialogHost key="sharing" />
        <NotionDbSyncHost key="notion-sync" />
        <GraphFullscreen key="graph" />
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden" style={rootStyle}>
        {restoreNotice}
        <a className="workspace-skip-link" href="#workspace-document">Skip to document</a>
      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        {sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth, minWidth: 200, maxWidth: 400 }} className="flex-shrink-0">
              <Navigation />
            </div>
            <ResizeHandle onResize={setSidebarWidth} initialSize={sidebarWidth} side="left" />
          </>
        )}

        {/* Canvas */}
        <div className="flex-1 min-w-0">
          <Canvas />
        </div>

        {/* Context Panel */}
        {contextPanelOpen && (
          <>
            <ResizeHandle onResize={setContextPanelWidth} initialSize={contextPanelWidth} side="right" />
            <div style={{ width: contextPanelWidth, minWidth: 260, maxWidth: 480 }} className="flex-shrink-0">
              <ContextPanel />
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Command Bar overlay */}
      <CommandBar key="commands" />
      <WikilinkChooser key="wikilinks" />
        <SharingDialogHost key="sharing" />
      <NotionDbSyncHost key="notion-sync" />

      {/* Graph fullscreen overlay */}
      <GraphFullscreen key="graph" />
    </div>
  );
}

/** Slide-in overlay panel for mobile: a backdrop that dismisses on tap plus a
 *  fixed-position drawer pinned to one edge. */
function MobileDrawer({
  side,
  onClose,
  children,
}: {
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
    <dialog ref={dialogRef} className="workspace-mobile-drawer" aria-label={side === "left" ? "Workspace navigation" : "Document panel"}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{ left: side === "left" ? 0 : "auto", right: side === "right" ? 0 : "auto", width: side === "right" ? "100%" : "min(88vw, 360px)" }}>
      <div className="h-full min-h-0 flex flex-col" style={{ background: "var(--bg-surface)" }}>
        <div className="workspace-context-header flex items-center justify-between px-4 shrink-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <span className="text-sm font-medium">{side === "left" ? "Workspace" : "Document panel"}</span>
          <button type="button" aria-label={side === "left" ? "Close navigation" : "Back to document"} onClick={onClose}
            className="interactive flex items-center justify-center" style={{ width: 44, height: 44 }}><X size={20} /></button>
        </div>
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
