import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { GraphExplorer } from "./GraphExplorer";

export function GraphFullscreen() {
  const open = useUIStore((s) => s.graphFullscreen);
  const active = useUIStore(
    (s) => s.openTabs.find((t) => t.id === s.activeTabId)?.noteId,
  );
  return open && active ? <GraphDialog noteId={active} /> : null;
}
function GraphDialog({ noteId }: { noteId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => useUIStore.getState().setGraphFullscreen(false);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    el?.showModal();
    return () => {
      el?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="Explore connected knowledge"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-[var(--bg-surface)] p-0 text-[var(--text-primary)]"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-[var(--glass-border)] px-4 py-2">
          <h2 className="text-sm font-medium">Explore your knowledge</h2>
          <button
            aria-label="Close graph"
            className="focus-ring rounded-lg p-3"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <GraphExplorer noteId={noteId} fullscreen />
        </div>
      </div>
    </dialog>
  );
}
