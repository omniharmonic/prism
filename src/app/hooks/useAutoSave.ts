import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateNote } from "./useParachute";

export function useAutoSave(
  noteId: string,
  getContent: () => string,
  debounceMs = 2000,
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

  // Cleanup timer on unmount; flush if pending
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current) doSave();
    };
  }, [doSave]);

  return { isSaving, lastSaved, scheduleSave, saveNow };
}
