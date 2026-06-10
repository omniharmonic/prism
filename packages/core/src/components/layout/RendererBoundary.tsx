import { Component, type ReactNode } from "react";

/**
 * Catches render/runtime errors from a content renderer so one failing note
 * never blanks the whole canvas (or the app). Shows an inline, recoverable
 * fallback with the error and a Retry that remounts the subtree. Keyed by the
 * active note id by the caller, so switching tabs clears a stuck error.
 */
export class RendererBoundary extends Component<
  { children: ReactNode; onReport?: (error: Error) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surface to the console for diagnosis; hosts may also wire onReport.
    console.error("Renderer crashed:", error);
    this.props.onReport?.(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-xl mx-auto mt-16 glass rounded-lg p-6" role="alert">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            This view ran into an error and couldn’t render.
          </p>
          <pre
            className="text-xs mt-2 whitespace-pre-wrap break-words"
            style={{ color: "var(--text-muted)" }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-4 px-3 py-1.5 rounded text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
