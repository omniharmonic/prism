import { useCallback, useRef } from "react";
import { useUIStore } from "../../app/stores/ui";
import { useKeyboardShortcuts } from "../../app/hooks/useKeyboardShortcuts";
import { Navigation } from "../navigation/Navigation";
import { Canvas } from "./Canvas";
import { ContextPanel } from "./ContextPanel";
import { StatusBar } from "./StatusBar";
import { CommandBar } from "./CommandBar";

export function Shell() {
  const {
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    contextPanelOpen,
    contextPanelWidth,
    setContextPanelWidth,
  } = useUIStore();

  useKeyboardShortcuts();

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}
    >
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
      <CommandBar />
    </div>
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
