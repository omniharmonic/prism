import { useVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable, VaultRequestError } from "../../data/VaultClient";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateNote } from "./useParachute";
import { markDirty, reportSaveFailure } from "../../lib/sync/syncState";

let autosaveInstances = 0;

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
  const client = useVaultClient();
  const sourceScope = useRef(client.scope?.()).current;
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef<string>("");
  const pendingRef = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  // Shared sync state (NP-OF-01): debounced edits count as "Saving…" and a
  // failure surfaces in the header with this editor's own retry.
  const syncKey = useRef(`autosave:${noteId}:${++autosaveInstances}`).current;
  const retryRef = useRef<() => void>(() => {});

  const doSave = useCallback(async () => {
    if (inFlight.current) {
      await inFlight.current;
      if (!pendingRef.current) return;
    }
    const content = getContent();
    if (content === lastContentRef.current) { pendingRef.current = false; markDirty(syncKey, false); return; }
    pendingRef.current = false;
    setIsSaving(true);
    setSaveError(null);
    const operation = (async () => {
      try {
        if (sourceScope !== undefined && client.scope?.() !== sourceScope) throw new VaultRequestError(403, "Workspace changed before saving.");
        await mutateAsync({ id: noteId, content, expectedScope: sourceScope });
        lastContentRef.current = content;
        reportSaveFailure(syncKey, null);
        if (!pendingRef.current) markDirty(syncKey, false);
        setLastSaved(new Date());
        savedCallback.current?.(content);
      } catch (error) {
        // Failed writes must not become the baseline for later saves.
        pendingRef.current = true;
        if (sourceScope && client.preserveDraft && isAccessUnavailable(error)) {
          try {
            await client.preserveDraft(noteId, content, sourceScope);
            pendingRef.current = false;
            setSaveError("Your draft is saved on this device for review in the original workspace. It has not been sent.");
          } catch {
            setSaveError("Your draft could not be saved on this device. Keep this page open and copy your changes before leaving.");
          }
        } else setSaveError("Changes could not be saved. Keep this page open and retry when ready.");
        if (pendingRef.current) reportSaveFailure(syncKey, { message: "Changes could not be saved.", retry: () => retryRef.current() });
        else markDirty(syncKey, false);
        throw error;
      } finally {
        setIsSaving(false);
      }
    })();
    inFlight.current = operation;
    try { await operation; }
    finally { if (inFlight.current === operation) inFlight.current = null; }
  }, [noteId, getContent, mutateAsync, client, sourceScope]);

  // Schedule a debounced save
  const scheduleSave = useCallback(() => {
    pendingRef.current = true;
    markDirty(syncKey, true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void doSave().catch(() => {}); }, debounceMs);
  }, [doSave, debounceMs]);

  // Flush immediately (for Cmd+S)
  const saveNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void doSave().catch(() => {});
  }, [doSave]);
  retryRef.current = saveNow;

  useEffect(() => {
    const handle: PendingSaveHandle = {
      flush: async () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (pendingRef.current || inFlight.current) await doSave();
      },
      discard: () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        pendingRef.current = false;
        markDirty(syncKey, false);
        reportSaveFailure(syncKey, null);
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
      if (pendingRef.current) void doSave().catch(() => {}).finally(() => { markDirty(syncKey, false); reportSaveFailure(syncKey, null); });
      else { markDirty(syncKey, false); reportSaveFailure(syncKey, null); }
    };
  }, [doSave, syncKey]);

  return { isSaving, lastSaved, saveError, scheduleSave, saveNow };
}
