import { lazy, Suspense, useState } from "react";
import type { Note } from "@prism/core/shell";

/**
 * The live document editor, loaded on demand (NP-PF-08): TipTap, ProseMirror, Yjs,
 * the socket provider and highlight.js are not part of the app's initial JavaScript.
 *
 * `preloadCollabEditor()` fetches the chunk ahead of the first open (on idle after
 * boot, and on the first interaction). Once it has arrived a document mounts the
 * editor DIRECTLY — no Suspense boundary, so no loading state is shown for a chunk
 * the browser already has. Only an open that beats the download shows the same
 * "Opening document…" line the editor itself starts with.
 */
type Module = typeof import("./CollabDocument");
let loaded: Module | null = null;
let pending: Promise<Module> | null = null;

export function preloadCollabEditor(): Promise<Module> {
  pending ??= import("./CollabDocument").then(
    (m) => (loaded = m),
    (e) => {
      pending = null; // a failed download may be retried by the next open
      throw e;
    },
  );
  return pending;
}

const Deferred = lazy(() => preloadCollabEditor().then((m) => ({ default: m.CollabDocument })));

export function CollabDocument(props: { noteId: string; note: Note }) {
  // Decided once per mount: switching branches later would remount the editor.
  const [direct] = useState(() => loaded !== null);
  if (direct && loaded) return <loaded.CollabDocument {...props} />;
  return (
    <Suspense fallback={<p role="status" className="p-6 text-sm">Opening document…</p>}>
      <Deferred {...props} />
    </Suspense>
  );
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
