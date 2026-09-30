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
  const updateNote = useUpdateNote();
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef<string>("");
  const pendingRef = useRef(false);

  const doSave = useCallback(async () => {
    const content = getContent();
    if (content === lastContentRef.current) return;

    lastContentRef.current = content;
    pendingRef.current = false;
    setIsSaving(true);

    try {
      await updateNote.mutateAsync({ id: noteId, content });
      setLastSaved(new Date());
      onSaved?.(content);
    } finally {
      setIsSaving(false);
    }
  }, [noteId, getContent, updateNote]);

  // Schedule a debounced save
  const scheduleSave = useCallback(() => {
    pendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSave, debounceMs);
  }, [doSave, debounceMs]);

  // Flush immediately (for Cmd+S)
  const saveNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    doSave();
  }, [doSave]);

  useEffect(() => {
    const handle: PendingSaveHandle = {
      flush: async () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (pendingRef.current) await doSave();
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
      if (pendingRef.current) doSave();
    };
  }, [doSave]);

  return { isSaving, lastSaved, scheduleSave, saveNow };
}
