import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateNote } from "./useParachute";

/**
 * Every mounted autosave, by note id — so an out-of-band write (restoring a
 * version) can first FLUSH the user's pending edits into the vault (they become
 * a version themselves, never lost) and then DISCARD the stale editor state, so
 * the unmount flush below can't write old content back over the restore.
 */
interface PendingSaveHandle {
  flush: () => Promise<void>;
  discard: () => void;
}
const pendingSaves = new Map<string, Set<PendingSaveHandle>>();

/** Save any debounced-but-unsent edits to `noteId` now. */
export async function flushPendingSaves(noteId: string): Promise<void> {
  await Promise.all([...(pendingSaves.get(noteId) ?? [])].map((h) => h.flush()));
}

/** Drop any unsent edits to `noteId` (after flushing — see above). */
export function discardPendingSaves(noteId: string): void {
  for (const h of pendingSaves.get(noteId) ?? []) h.discard();
}

export function useAutoSave(
  noteId: string,
  getContent: () => string,
  debounceMs = 2000,
  onSaved?: (content: string) => void,
) {
  const { mutateAsync } = useUpdateNote();
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef<string>("");
  const pendingRef = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);

  const doSave = useCallback(async () => {
    if (inFlight.current) {
      await inFlight.current;
      if (!pendingRef.current) return;
    }
    const content = getContent();
    if (content === lastContentRef.current) { pendingRef.current = false; return; }
    pendingRef.current = false;
    setIsSaving(true);
    setSaveError(null);
    const operation = (async () => {
      try {
        await mutateAsync({ id: noteId, content });
        lastContentRef.current = content;
        setLastSaved(new Date());
        savedCallback.current?.(content);
      } catch (error) {
        // Failed writes must not become the baseline for later saves.
        pendingRef.current = true;
        setSaveError("Changes could not be saved. Keep this page open and retry when ready.");
        throw error;
      } finally {
        setIsSaving(false);
      }
    })();
    inFlight.current = operation;
    try { await operation; }
    finally { if (inFlight.current === operation) inFlight.current = null; }
  }, [noteId, getContent, mutateAsync]);

  // Schedule a debounced save
  const scheduleSave = useCallback(() => {
    pendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void doSave().catch(() => {}); }, debounceMs);
  }, [doSave, debounceMs]);

  // Flush immediately (for Cmd+S)
  const saveNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void doSave().catch(() => {});
  }, [doSave]);

  useEffect(() => {
    const handle: PendingSaveHandle = {
      flush: async () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (pendingRef.current || inFlight.current) await doSave();
      },
      discard: () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        pendingRef.current = false;
        lastContentRef.current = getContent();
      },
    };
    const set = pendingSaves.get(noteId) ?? new Set<PendingSaveHandle>();
    set.add(handle);
    pendingSaves.set(noteId, set);
    return () => {
      set.delete(handle);
      if (set.size === 0) pendingSaves.delete(noteId);
    };
  }, [noteId, doSave, getContent]);

  // Cleanup timer on unmount; flush if pending
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current) void doSave().catch(() => {});
    };
  }, [doSave]);

  return { isSaving, lastSaved, saveError, scheduleSave, saveNow };
}
