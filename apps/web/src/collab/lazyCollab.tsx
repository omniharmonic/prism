import { useEffect, useState } from "react";
import { inferContentType, type Note } from "@prism/core/shell";
import { retryImport } from "../../../../packages/core/src/lib/retryImport";

/**
 * The live document editor, loaded on demand (NP-PF-08): TipTap, ProseMirror, Yjs,
 * the socket provider and highlight.js are not part of the app's initial JavaScript.
 *
 * `preloadCollabEditor()` fetches the chunk ahead of the first open (on idle after
 * boot, and on the first interaction). Once it has arrived a document mounts the
 * editor DIRECTLY, so no loading state is shown for a chunk the browser already has.
 * Only an open that beats the download shows the same "Opening document…" line the
 * editor itself starts with. A failed download is retried quietly a couple of times
 * (`retryImport`) before the page says so — with its own "Try again", never the
 * renderer crash card — and is never remembered: the next attempt asks again.
 */
type Module = typeof import("./CollabDocument");
let loaded: Module | null = null;
let pending: Promise<Module> | null = null;

type Loader = () => Promise<Module>;
const importEditor: Loader = () => import("./CollabDocument");
let loader: Loader = importEditor;
/** Fixtures only: replace how the editor module is fetched (a failing download, a stand-in). */
export function setCollabEditorLoaderForTests(next: Loader | null): void {
  loader = next ?? importEditor;
  loaded = null;
  pending = null;
}

export function preloadCollabEditor(): Promise<Module> {
  pending ??= retryImport(() => loader()).then(
    (m) => (loaded = m),
    (e) => {
      pending = null; // a failed download may be retried by the next open
      throw e;
    },
  );
  return pending;
}

export function CollabDocument(props: { noteId: string; note: Note }) {
  // The module this mount renders: already here (no loading state at all), or fetched now.
  // NOT React.lazy: a lazy component remembers a failed download forever, so "Try again"
  // would land in the same rejection. Each attempt asks again.
  const [state, setState] = useState<{ module: Module | null; error: string | null; attempt: number }>(() => ({ module: loaded, error: null, attempt: 0 }));
  useEffect(() => {
    if (state.module) return;
    let live = true;
    preloadCollabEditor().then(
      (module) => { if (live) setState((s) => ({ ...s, module, error: null })); },
      () => { if (live) setState((s) => ({ ...s, error: navigator.onLine === false ? "You\u2019re offline and the editor isn\u2019t on this device yet. Reconnect, then try again." : "The editor couldn\u2019t be loaded. Check your connection and try again." })); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per attempt
  }, [state.attempt]);
  const canvas = inferContentType(props.note) === "canvas";
  if (state.error) {
    return (
      <div role="alert" className="p-6 text-sm">
        <p>{state.error}</p>
        <button type="button" className="focus-ring mt-3 min-h-control rounded-lg border border-[var(--glass-border)] px-4"
          onClick={() => setState((s) => ({ module: null, error: null, attempt: s.attempt + 1 }))}>Try again</button>
      </div>
    );
  }
  if (!state.module) return <p role="status" className="p-6 text-sm">{canvas ? "Loading the canvas\u2026" : "Opening document\u2026"}</p>;
  return <state.module.CollabDocument {...props} />;
}

/**
 * On the web/PWA, real-time editing is universal: any collab-capable note (Canvas
 * only passes those ids) renders live. Sharing only controls who *else* can connect.
 */
export function useLiveCollab(noteId: string): boolean {
  return !!noteId;
}

/** Fetch the editor when the browser is idle, or at the first interaction, whichever is first. */
export function preloadCollabEditorWhenIdle(): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.removeEventListener("pointerdown", go, true);
    window.removeEventListener("keydown", go, true);
    void preloadCollabEditor().catch(() => undefined);
  };
  window.addEventListener("pointerdown", go, { capture: true, passive: true });
  window.addEventListener("keydown", go, { capture: true, passive: true });
  const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(go, { timeout: 3000 });
  else window.setTimeout(go, 1200);
}
