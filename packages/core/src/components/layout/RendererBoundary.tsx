import { Component, type ReactNode } from "react";
import { isChunkLoadError } from "../../lib/retryImport";

/**
 * Catches render/runtime errors from a content renderer so one failing note
 * never blanks the whole canvas (or the app). Shows an inline, recoverable
 * fallback with the error and a Retry that remounts the subtree. Keyed by the
 * active note id by the caller, so switching tabs clears a stuck error.
 */
export class RendererBoundary extends Component<
  { children: ReactNode; onReport?: (error: Error) => void },
  { error: Error | null; retrying: boolean }
> {
  state: { error: Error | null; retrying: boolean } = { error: null, retrying: false };
  /** A download failure (not a bug in the view) is retried ONCE by itself before the card shows. */
  private autoRetried = false;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surface to the console for diagnosis; hosts may also wire onReport.
    console.error("Renderer crashed:", error);
    this.props.onReport?.(error);
    if (isChunkLoadError(error) && !this.autoRetried && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
      this.autoRetried = true;
      this.setState({ retrying: true });
      // Not cleared on unmount (StrictMode simulates one): a late setState on a gone boundary is a no-op.
      setTimeout(() => this.setState({ error: null, retrying: false }), 800);
    }
  }

  render() {
    if (this.state.error && this.state.retrying) {
      return <p role="status" className="p-6 text-sm" style={{ color: "var(--text-secondary)" }}>Loading…</p>;
    }
    if (this.state.error) {
      const download = isChunkLoadError(this.state.error);
      return (
        <div className="max-w-xl mx-auto mt-16 glass rounded-lg p-6" role="alert">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {download ? "Part of Prism couldn’t be downloaded." : "This view ran into an error and couldn’t render."}
          </p>
          <pre
            className="text-xs mt-2 whitespace-pre-wrap break-words"
            style={{ color: "var(--text-muted)" }}
          >
            {download ? "Check your connection, then try again. If it keeps failing, reload Prism." : this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => this.setState({ error: null, retrying: false })}
              className="px-3 py-1.5 rounded text-xs font-medium"
              style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
            >
              Retry
            </button>
            {download && (
              <button onClick={() => window.location.reload()} className="px-3 py-1.5 rounded text-xs font-medium border" style={{ borderColor: "var(--glass-border)", color: "var(--text-primary)" }}>
                Reload Prism
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
