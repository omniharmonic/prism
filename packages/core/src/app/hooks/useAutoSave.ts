import { useVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable, VaultRequestError } from "../../data/VaultClient";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateNote } from "./useParachute";
import { markDirty, reportSaveFailure } from "../../lib/sync/syncState";
import type { Note } from "../../lib/types";

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
  /**
   * What this editor holds that the server does not:
   *  clean   nothing — what is on screen is what it mounted from or last saved
   *  dirty   typed and not yet saved (debounced or in flight)
   *  draft   typed in an editor that never writes (propose / governed / read-only):
   *          the text exists ONLY here and must never be replaced from outside
   *  parked  a save was refused as a conflict and the draft is in "Needs review"
   *  failed  a save failed and the draft is only in this editor
   */
  state: () => EditorSaveState;
  /** The content this editor last wrote successfully (null = nothing written yet). */
  saved: () => string | null;
  /** The revision (`updatedAt`) this editor's content is built on. */
  base: () => string | null;
  /** The stored content of that revision, as the server holds it (what it mounted from / last saved). */
  baseContent: () => string | null;
  /** The same content now has a newer revision (a metadata / path / tag write): build on that one. */
  rebase: (updatedAt: string) => void;
}
export type EditorSaveState = "clean" | "dirty" | "draft" | "parked" | "failed";
const pendingSaves = new Map<string, Set<PendingSaveHandle>>();

/** Save any debounced-but-unsent edits to `noteId` now. */
export async function flushPendingSaves(noteId: string): Promise<void> {
  await Promise.all([...(pendingSaves.get(noteId) ?? [])].map((h) => h.flush()));
}

/** Drop any unsent edits to `noteId` (after flushing — see above). */
export function discardPendingSaves(noteId: string): void {
  for (const h of pendingSaves.get(noteId) ?? []) h.discard();
}

const newer = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = a ? Date.parse(a) : NaN;
  const y = b ? Date.parse(b) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? x > y : false;
};

/**
 * NP-OF-05: what should happen with a re-read of `noteId` (content + revision)
 * that differs from what the open plain editor shows?
 *  none    no editor is mounted for the note
 *  own     the echo of this editor's own save, or the revision it is already on
 *  stale   NOT strictly newer than the editor's base (an older or equal copy from
 *          a cache or a slow read) — never shown, never offered
 *  clean   newer, and every editor is clean: may be adopted (silently only when
 *          nobody is interacting with the page — the caller decides)
 *  dirty   newer, and an editor holds unsaved typing: keep it; its next save names
 *          its OWN base, so the server answers 409 and the draft goes to review
 *  draft   newer, and an editor holds text that is never written (propose mode /
 *          read-only draft): never adopt — the text exists nowhere else
 *  parked / failed   newer; the draft is in "Needs review" / only in the editor
 */
export type RemoteVerdict = "none" | "own" | "stale" | EditorSaveState;
export function remoteAdoption(noteId: string, remote: { content: string; updatedAt: string | null | undefined }): RemoteVerdict {
  const handles = [...(pendingSaves.get(noteId) ?? [])];
  if (handles.length === 0) return "none";
  // The SAME content under a newer revision (someone changed the icon, a property,
  // the path): not a content change. Each editor built on exactly this content
  // moves its base forward, so its next save does not conflict with a metadata write.
  let same = 0;
  for (const h of handles) {
    if (h.baseContent() !== remote.content && h.saved() !== remote.content) continue;
    same++;
    const at = h.base();
    if (remote.updatedAt && (at === null || newer(remote.updatedAt, at))) h.rebase(remote.updatedAt);
  }
  if (same === handles.length) return "own";
  // Strictly newer than EVERY editor's base, or it is not news (H3: never an older copy).
  if (handles.some((h) => { const at = h.base(); return at !== null && !newer(remote.updatedAt, at); })) return "stale";
  const states = handles.map((h) => h.state());
  for (const s of ["draft", "failed", "parked", "dirty"] as const) if (states.includes(s)) return s;
  return "clean";
}

/** The save state of the editors mounted for a note ("clean" when there are none). */
export function editorSaveState(noteId: string): EditorSaveState {
  const states = [...(pendingSaves.get(noteId) ?? [])].map((h) => h.state());
  for (const s of ["draft", "failed", "parked", "dirty"] as const) if (states.includes(s)) return s;
  return "clean";
}

export interface AutoSaveOptions {
  /** The `updatedAt` of the note this editor mounted from. The editor keeps its OWN
   *  base from here on (advanced only by its own confirmed saves) and names it on
   *  every save, so a change made elsewhere meanwhile is a 409 — never overwritten. */
  base?: string | null;
  /** The stored content of that revision (`note.content` at mount), to recognise the same content under a newer revision. */
  content?: string | null;
  /** This editor never writes (propose mode, read-only draft). Local changes still count as a draft. */
  noWrite?: boolean;
}

export function useAutoSave(
  noteId: string,
  getContent: () => string,
  debounceMs = 2000,
  onSaved?: (content: string) => void,
  options?: AutoSaveOptions,
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
  const wroteRef = useRef(false);
  // H1: the editor's own base revision — set from the note it MOUNTED from, moved
  // only by its own confirmed save. Never the query cache's `updatedAt`, which an
  // event re-read advances while this editor still shows (and types on) older text.
  const baseRef = useRef<{ id: string; base: string | null; content: string | null }>({ id: noteId, base: options?.base ?? null, content: options?.content ?? null });
  if (baseRef.current.id !== noteId) baseRef.current = { id: noteId, base: options?.base ?? null, content: options?.content ?? null };
  /** Changed locally since the last confirmed save (set even where nothing is ever written). */
  const touchedRef = useRef(false);
  const noWriteRef = useRef(!!options?.noWrite);
  noWriteRef.current = !!options?.noWrite;
  /** Parked for conflict review (as opposed to simply failed). */
  const parkedRef = useRef(false);
  /** A save failed, or the draft was parked for review: remote content must not replace what is on screen. */
  const heldRef = useRef(false);
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
        const base = baseRef.current.base;
        const saved = await mutateAsync({ id: noteId, content, expectedScope: sourceScope, ...(base ? { ifUpdatedAt: base } : {}) });
        // A confirmed write moves the base to the revision it produced. A write that
        // was only QUEUED (offline / behind other queued rows) has no revision yet:
        // the base stays, and the host maps it once its own delivery is confirmed.
        const result = saved as (Note & { _queued?: boolean }) | undefined;
        if (result && !result._queued && typeof result.updatedAt === "string" && result.updatedAt) baseRef.current = { id: noteId, base: result.updatedAt, content };
        else baseRef.current = { ...baseRef.current, content };
        lastContentRef.current = content;
        wroteRef.current = true;
        heldRef.current = false;
        parkedRef.current = false;
        if (!pendingRef.current) touchedRef.current = false;
        reportSaveFailure(syncKey, null);
        if (!pendingRef.current) markDirty(syncKey, false);
        setLastSaved(new Date());
        savedCallback.current?.(content);
      } catch (error) {
        // Failed writes must not become the baseline for later saves.
        pendingRef.current = true;
        heldRef.current = true;
        if (sourceScope && client.preserveDraft && isAccessUnavailable(error)) {
          try {
            await client.preserveDraft(noteId, content, sourceScope);
            pendingRef.current = false;
            setSaveError("Your draft is saved on this device for review in the original workspace. It has not been sent.");
          } catch {
            setSaveError("Your draft could not be saved on this device. Keep this page open and copy your changes before leaving.");
          }
        } else if (sourceScope && client.preserveDraft && error instanceof VaultRequestError && (error.status === 409 || error.status === 428)) {
          // The page changed somewhere else. A retry would re-read the newer
          // revision and overwrite it, so this version goes to conflict review
          // instead (saved on this device; "Needs review" in the header).
          try {
            await client.preserveDraft(noteId, content, sourceScope, "conflict");
            pendingRef.current = false;
            parkedRef.current = true;
            lastContentRef.current = content;
            setSaveError("This page changed somewhere else. Your version is saved on this device — open “Needs review” to compare before applying it.");
          } catch {
            setSaveError("This page changed somewhere else and your version could not be saved on this device. Copy your changes before leaving.");
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
  /** A local change happened. Editors that never write call this alone (C1). */
  const touch = useCallback(() => { touchedRef.current = true; }, []);
  const scheduleSave = useCallback(() => {
    touchedRef.current = true;
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
        heldRef.current = false;
        parkedRef.current = false;
        touchedRef.current = false;
        markDirty(syncKey, false);
        reportSaveFailure(syncKey, null);
        lastContentRef.current = getContent();
      },
      state: () =>
        noWriteRef.current && touchedRef.current ? "draft"
        : parkedRef.current ? "parked"
        : heldRef.current ? "failed"
        : pendingRef.current || inFlight.current !== null || touchedRef.current ? "dirty"
        : "clean",
      saved: () => (wroteRef.current ? lastContentRef.current : null),
      base: () => baseRef.current.base,
      baseContent: () => baseRef.current.content,
      rebase: (updatedAt) => { baseRef.current = { ...baseRef.current, base: updatedAt }; },
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

  return { isSaving, lastSaved, saveError, scheduleSave, saveNow, touch };
}
