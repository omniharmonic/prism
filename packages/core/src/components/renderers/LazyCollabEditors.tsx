import { Component, Suspense, lazy, useMemo, useState, type ComponentType, type ComponentProps, type ReactNode } from "react";

class EditorImportError extends Error {}

class EditorLoadBoundary extends Component<
  { children: ReactNode; label: string; retry: () => void },
  { failed: boolean; needsReload: boolean }
> {
  state = { failed: false, needsReload: false };
  static getDerivedStateFromError(error: Error) { return { failed: true, needsReload: error instanceof EditorImportError }; }
  componentDidCatch(error: Error) { console.error("Collaborative editor failed to open:", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-6 text-sm">
        <p className="font-medium">The {this.props.label} couldn’t open.</p>
        <p className="mt-2 text-[var(--text-secondary)]">{this.state.needsReload ? "The editor’s files could not be loaded. Check your connection, then reload Prism. Save any drafts in other tabs first." : "Try reopening the editor. Your document session remains open."}</p>
        <button type="button" onClick={this.state.needsReload ? () => window.location.reload() : this.props.retry} className="focus-ring mt-4 min-h-11 rounded-lg border border-[var(--glass-border)] px-4">{this.state.needsReload ? "Reload Prism" : "Retry opening editor"}</button>
      </div>
    );
  }
}

/** Load only the active engine. The host keeps ownership of its Y.Doc, socket,
 * and local persistence while loading/retrying; neither a spinner nor an import
 * failure should recreate a collaborative session. Runtime failures can retry
 * in place; failed module fetches require an explicit reload because browsers
 * cache the rejected import, even with a fresh React lazy identity. */
function deferredEditor<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>, label: string) {
  return function DeferredEditor(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const Editor = useMemo(() => lazy(() => load().catch(() => { throw new EditorImportError("Editor files unavailable"); })), [attempt]);
    return (
      <EditorLoadBoundary key={attempt} label={label} retry={() => setAttempt(value => value + 1)}>
        <Suspense fallback={<div role="status" className="p-6 text-sm text-[var(--text-secondary)]">Loading {label}…</div>}>
          <Editor {...props} />
        </Suspense>
      </EditorLoadBoundary>
    );
  };
}

export const CollabCanvas = deferredEditor<ComponentProps<typeof import("./CollabCanvas").CollabCanvas>>(
  () => import("./CollabCanvas").then(module => ({ default: module.CollabCanvas })), "canvas",
);
export const CollabCodeEditor = deferredEditor<ComponentProps<typeof import("./CollabCodeEditor").CollabCodeEditor>>(
  () => import("./CollabCodeEditor").then(module => ({ default: module.CollabCodeEditor })), "code editor",
);
export const CollabSpreadsheet = deferredEditor<ComponentProps<typeof import("./CollabSpreadsheet").CollabSpreadsheet>>(
  () => import("./CollabSpreadsheet").then(module => ({ default: module.CollabSpreadsheet })), "spreadsheet",
);
